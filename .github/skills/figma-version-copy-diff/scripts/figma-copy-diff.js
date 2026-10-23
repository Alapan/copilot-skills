#!/usr/bin/env node
const FIGMA_API_BASE_URL = "https://api.figma.com/v1";

function fail(message, details) {
  const result = {
    ok: false,
    error: message,
  };

  if (details) {
    result.details = details;
  }
  process.stderr.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(1);
}

function parseArguments(argv) {

  const options = {
    figmaUrl: undefined,
    previousVersionId: undefined,
    currentVersionId: undefined,
    changeTypes: new Set(["added", "modified", "removed"]),
  };

  for (let index = 0; index < argv.length; index += 1) {

    const argument = argv[index];

    if (!argument.startsWith("--") && !options.figmaUrl) {
      options.figmaUrl = argument;
      continue;
    }

    switch (argument) {
      case "--previous-version":
        options.previousVersionId = argv[++index];
        break;
      case "--current-version":
        options.currentVersionId = argv[++index];
        break;
      case "--change-types": {
        const value = argv[++index];
        if (!value) {
          fail("--change-types requires a comma-separated value");
        }
        options.changeTypes = new Set(
          value
            .split(",")
            .map((item) => item.trim().toLowerCase())
            .filter(Boolean),
        );
        break;
      }
      default:
        fail(`Unknown argument: ${argument}`);
    }
  }

  if (!options.figmaUrl) {
    fail(
      [
        "A Figma URL is required.",
        "",
        "Usage:",
        'node figma-copy-diff.mjs "<figma-url>"',
        "",
        "Optional:",
        "  --previous-version <version-id>",
        "  --current-version <version-id>",
        "  --change-types added,modified,removed",
      ].join("\n"),
    );
  }

  if (
    Boolean(options.previousVersionId) !==
    Boolean(options.currentVersionId)
  ) {
    fail(
      "--previous-version and --current-version must be provided together",
    );
  }

  const supportedChangeTypes = new Set(
    [
      "added",
      "modified",
      "removed"
    ]
  );

  for (const changeType of options.changeTypes) {
    if (!supportedChangeTypes.has(changeType)) {
      fail(`Unsupported change type: ${changeType}`);
    }
  }
  return options;
}

function parseFigmaUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    fail("The supplied Figma URL is invalid");
  }
  const pathParts = url.pathname.split("/").filter(Boolean);

  // Typical URLs:
  // /design/:fileKey/:fileName
  // /file/:fileKey/:fileName
  // /proto/:fileKey/:fileName
  const fileTypeIndex = pathParts.findIndex((part) =>
    ["design", "file", "proto", "board"].includes(part),
  );

  if (fileTypeIndex === -1 || !pathParts[fileTypeIndex + 1]) {
    fail("Could not extract a Figma file key from the supplied URL");
  }

  const fileKey = pathParts[fileTypeIndex + 1];

  // Figma URLs commonly contain node-id=123-456.
  // The REST API expects 123:456.
  const rawNodeId =
    url.searchParams.get("node-id") ?? url.searchParams.get("node_id");

  const nodeId = rawNodeId
    ? decodeURIComponent(rawNodeId).replace(/-/g, ":")
    : undefined;
  return {
    fileKey,
    nodeId,
  };
}

async function figmaRequest(path, token) {
  const response = await fetch(`${FIGMA_API_BASE_URL}${path}`, {
    headers: {
      "X-Figma-Token": token,
      Accept: "application/json",
    },
  });
  const responseText = await response.text();
  let body;

  try {
    body = responseText ? JSON.parse(responseText) : null;
  } catch {
    body = responseText;
  }

  if(response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    fail("Figma API rate limit exceeded", {
      retryAfter,
      path
    });
  }

  if (!response.ok) {
    fail(`Figma API request failed with HTTP ${response.status}`, {
      path,
      response: body,
    });
  }
  return body;
}

function buildFilePath(fileKey, { versionId, nodeId } = {}) {
  const query = new URLSearchParams();

  if (versionId) {
    query.set("version", versionId);
  }
  if (nodeId) {
    query.set("ids", nodeId);
  }

  const queryString = query.toString();
  return `/files/${encodeURIComponent(fileKey)}${
    queryString ? `?${queryString}` : ""
  }`;
}

async function fetchVersions(fileKey, token) {

  const result = await figmaRequest(
    `/files/${encodeURIComponent(fileKey)}/versions`,
    token,
  );
  if (!Array.isArray(result?.versions)) {
    fail("Figma returned an unexpected version-history response");
  }
  return result.versions;
}

async function fetchDesignState({
  fileKey,
  versionId,
  nodeId,
  token,
}) {
  return figmaRequest(
    buildFilePath(fileKey, {
      versionId,
      nodeId,
    }),
    token,
  );
}

function sortVersionsNewestFirst(versions) {
  return [...versions].sort((left, right) => {
    const leftTime = Date.parse(left.created_at);
    const rightTime = Date.parse(right.created_at);
    if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) {
      return 0;
    }
    return rightTime - leftTime;
  });
}

function selectPreviousVersion(versions, currentVersionId) {
  const sortedVersions = sortVersionsNewestFirst(versions);
  return sortedVersions.find(
    (version) => version?.id && version.id !== currentVersionId,
  );
}

function getDocumentRoot(fileJson) {
  if (fileJson?.document) {
    return fileJson.document;
  }
  fail("The Figma response did not contain a document tree");
}

function extractTextNodes(documentRoot) {
  const textNodes = new Map();
  function walk(node, ancestors = []) {
    if (!node || typeof node !== "object") {
      return;
    }
    const currentAncestor = {
      id: node.id ?? null,
      name: node.name ?? null,
      type: node.type ?? null,
    };
    if (node.type === "TEXT" && typeof node.characters === "string") {
      const usefulAncestors = ancestors.filter((ancestor) =>
        [
          "CANVAS",
          "SECTION",
          "FRAME",
          "COMPONENT",
          "COMPONENT_SET",
          "INSTANCE",
          "GROUP",
        ].includes(ancestor.type),
      );
      textNodes.set(node.id, {
        nodeId: node.id,
        nodeName: node.name ?? null,
        text: node.characters,
        context: normaliseContext(usefulAncestors),
      });
    }
    if (Array.isArray(node.children)) {
      const nextAncestors = [...ancestors, currentAncestor];
      for (const child of node.children) {
        walk(child, nextAncestors);
      }
    }
  }
  walk(documentRoot);
  return textNodes;
}

function findLastAncestor(ancestors, types) {
  return [...ancestors]
    .reverse()
    .find((ancestor) => types.includes(ancestor.type));
}

function normaliseContext(ancestors) {
  const page = findLastAncestor(ancestors, ["CANVAS"]);
  const section = findLastAncestor(ancestors, ["SECTION"]);
  const frame = findLastAncestor(ancestors, ["FRAME"]);
  const component = findLastAncestor(ancestors, [
    "COMPONENT",
    "COMPONENT_SET",
    "INSTANCE",
  ]);
  return {
    page: page?.name ?? null,
    section: section?.name ?? null,
    frame: frame?.name ?? null,
    component: component?.name ?? null,
    hierarchy: ancestors
      .filter((ancestor) => ancestor.name)
      .map((ancestor) => ({
        id: ancestor.id,
        name: ancestor.name,
        type: ancestor.type,
      })),
  };
}

function compareTextNodes(
  previousNodes,
  currentNodes,
  requestedChangeTypes,
) {
  const changes = [];
  for (const [nodeId, currentNode] of currentNodes) {
    const previousNode = previousNodes.get(nodeId);
    if (!previousNode) {
      if (requestedChangeTypes.has("added")) {
        changes.push({
          changeType: "added",
          nodeId,
          nodeName: currentNode.nodeName,
          previousText: null,
          currentText: currentNode.text,
          context: currentNode.context,
        });
      }
      continue;
    }
    if (
      previousNode.text !== currentNode.text &&
      requestedChangeTypes.has("modified")
    ) {
      changes.push({
        changeType: "modified",
        nodeId,
        nodeName: currentNode.nodeName ?? previousNode.nodeName,
        previousText: previousNode.text,
        currentText: currentNode.text,
        context: currentNode.context,
      });
    }
  }
  if (requestedChangeTypes.has("removed")) {
    for (const [nodeId, previousNode] of previousNodes) {
      if (!currentNodes.has(nodeId)) {
        changes.push({
          changeType: "removed",
          nodeId,
          nodeName: previousNode.nodeName,
          previousText: previousNode.text,
          currentText: null,
          context: previousNode.context,
        });
      }
    }
  }
  return changes.sort((left, right) => {
    const leftContext = [
      left.context?.page,
      left.context?.section,
      left.context?.frame,
      left.nodeName,
    ]
      .filter(Boolean)
      .join("/");
    const rightContext = [
      right.context?.page,
      right.context?.section,
      right.context?.frame,
      right.nodeName,
    ]
      .filter(Boolean)
      .join("/");
    return leftContext.localeCompare(rightContext);
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const token = process.env.FIGMA_TOKEN;
  if (!token) {
    fail(
      "FIGMA_TOKEN is not set. Export a Figma personal access token before running the script.",
    );
  }
  const { fileKey, nodeId } = parseFigmaUrl(options.figmaUrl);
  let currentVersionId = options.currentVersionId;
  let previousVersionId = options.previousVersionId;
  let currentCreatedAt = null;
  let previousCreatedAt = null;
  let currentState;
  if (currentVersionId) {
    currentState = await fetchDesignState({
      fileKey,
      versionId: currentVersionId,
      nodeId,
      token,
    });
  } else {
    currentState = await fetchDesignState({
      fileKey,
      nodeId,
      token,
    });
    currentVersionId = currentState.version ?? "current";
    currentCreatedAt = currentState.lastModified ?? null;
  }

  if (!previousVersionId) {
    const versions = await fetchVersions(fileKey, token);
    const previousVersion = selectPreviousVersion(
      versions,
      currentState.version,
    );

    if (!previousVersion) {
      const output = {
        ok: true,
        fileKey,
        scope: {
          nodeId: nodeId ?? null,
        },
        comparison: null,
        changes: [],
        limitations: [
          "No previous Figma version was available for comparison.",
        ],
        message: "A copy comparison could not be completed.",
      };
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      return;
    }
    previousVersionId = previousVersion.id;
    previousCreatedAt = previousVersion.created_at ?? null;
  }

  const previousState = await fetchDesignState({
    fileKey,
    versionId: previousVersionId,
    nodeId,
    token,
  });

  if (!currentCreatedAt) {
    currentCreatedAt = currentState.lastModified ?? null;
  }

  if (!previousCreatedAt) {
    previousCreatedAt = previousState.lastModified ?? null;
  }

  const currentTextNodes = extractTextNodes(
    getDocumentRoot(currentState),
  );

  const previousTextNodes = extractTextNodes(
    getDocumentRoot(previousState),
  );

  const changes = compareTextNodes(
    previousTextNodes,
    currentTextNodes,
    options.changeTypes,
  );

  const output = {
    ok: true,
    fileKey,
    scope: {
      nodeId: nodeId ?? null,
    },
    comparison: {
      previousVersionId,
      currentVersionId,
      previousCreatedAt,
      currentCreatedAt,
    },
    summary: {
      previousTextNodeCount: previousTextNodes.size,
      currentTextNodeCount: currentTextNodes.size,
      changedTextNodeCount: changes.length,
      added: changes.filter(
        (change) => change.changeType === "added",
      ).length,
      modified: changes.filter(
        (change) => change.changeType === "modified",
      ).length,
      removed: changes.filter(
        (change) => change.changeType === "removed",
      ).length,
    },
    changes,
    limitations: [
      "The result compares Figma design states, not individual edit events.",
      "Multiple edits may exist between the compared Figma checkpoints.",
    ],
    message:
      changes.length === 0
        ? "No user-facing copy differences were found between the compared Figma states."
        : undefined,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((error) => {
  fail("Unexpected error while comparing Figma versions", {
    message: error instanceof Error ? error.message : String(error),
  });
});