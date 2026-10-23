---
name: figma-version-copy-diff
description: >
  Compare the current version of a Figma design with its most recent previous version and report user-facing text that was added, modified or removed. Use when asked what copy changed in a Figma file, frame or node.
---

# Figma Version Text Diff

Compare user-facing text between two Figma design states.

The default comparison is:

Current Figma state
vs
Most recent previous version available in Figma version history

The comparison must be deterministic.

Do no infer previous text, guess what changed, or use semantic similarity to determine whether text changed.

## Input

Require a Figma file, frame, or node URL.

Optionally accept explicit previous and current version IDs.

If explicit version IDs are provided, compare those versions.

Otherwise compare the live current state against the most recent previous version available in Figma version history.

## Execution

When this skill is activated, identify the complete Figma URL supplied by the user.

From the repository root, run:

```bash
node .github/skills/figma-version-copy-diff/scripts/figma-copy-diff.js <figma-url>
```

## Required capabilities

This workflow requires access to Figma capabilities that can:

1. Retrieve the version history for a Figma file.
2. Retrieve the current JSON representation of the file or relevant node.
3. Retrieve the JSON representation of a specfic historical version.

If any required capability is unavailable, stop and explain which capability is missing.

Do not infer historical state from the current design.

## Workflow

### 1. Parse the Figma URL

Extract:

- file key
- node ID, if present

If a node ID is present, use that node as the comparison scope where supported.

Do not invent a node ID.

### 2. Resolve the versions

If explicit previous and current version IDs were provided, use them.

Otherwise:

1. Retrieve the Figma file's version history.
2. Identify the most recent previous available version.
3. Use the live file as the current state.

Record the version identifiers and timestamps where available.

If no previous version is available, stop and report that a comparison cannot be performed.

Do not treat all current text as newly added.

### 3. Retrieve both design states

Retrieve:

- the current Figma file or node as JSON.
- the same file or node from the previous selected version as JSON.

When a node ID was supplied, restrict retrieval to that node and its descendants where supported.

### 4. Extract text nodes

Traverse both JSON document trees.

Only compare nodes whose type is `TEXT`.

For each text node retain:

- `id`
- `name`
- text value
- relevant parent/frame names

Use the actual text value from Figma.

Do not include styling, colour, spacing or layout changes in the text comparison.

### 5. Compare text nodes

Match text nodes primarily by Figma node ID.

Classify differences as follows.

#### Modified

The node ID exists in both states but the text value differs.

Example:

Previous:

`Continue`

Current:

`Continue to your results`

Return:

{
  "changeType": "modified",
  "nodeId": "5914:26828",
  "previousText": "Continue",
  "currentText": "Continue to your results"
}

#### Added

The text node exists in the current state but not the previous state.

Return:

{
  "changeType": "added",
  "nodeId": "5914:26829",
  "previousText": null,
  "currentText": "Find out more"
}

#### Removed

The text node exists in the previous state but not the current state.

Return:

{
  "changeType": "removed",
  "nodeId": "5914:26830",
  "previousText": "Learn more",
  "currentText": null
}

#### Unchanged

If the text value is identical, do not include the node in the result.

A node whose styling or position changed but whose text did not change must not be reported as a text change.

### 6. Add structural context

For each changed text node, include useful Figma hierarchy information when available, such as:

- page name
- section name
- frame name
- component name
- text layer name

Only use context present in the Figma data.

Do not invent semantic descriptions for unidentified frames or nodes.

### 7. Return the result

Return only text changes

Prefer structured JSON.

Example:

{
  "comparison": {
    "previousVersionId": "12345",
    "currentVersionId": "current"
  },
  "changes": [
    {
      "changeType": "modified",
      "nodeId": "5914:26828",
      "nodeName": "Primary CTA",
      "previousText": "Continue",
      "currentText": "Continue to your results",
      "context": {
        "page": "Form page",
        "frame": "Results"
      }
    }
  ]
}

If there are no text changes, return:

{
  "changes": [],
  "message": "No user-facing text differences were found between the compared Figma states"
}

## Important constraints

Never:

- fabricate previous copy;
- infer what probably changed;
- treat the current design as evidence of its previous state
- report visual-only changes as text changes
- create or maintain a local snapshot
- report unchanged text

## Limitations

The comparison identifies text differences between two Figma design states.

It does not represent a real-time edit audit log.

The selected previous version may contain multiple design changes relative to the current state.

Describe results as differences between the compared Figma states, not as proof that a specific individual edit caused the change.
