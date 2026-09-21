# Baseline for ticket transport (2026-09-20)

This is a frozen observation, not a human-verified implementation assessment.

- Existing analyze artifact: `results/run-mu85edw8-y3b72kto.json`.
- Existing AstraQA verdict record: `astraqa/data/tenants/local/snapshots/coworklocal_s1/verdicts.json` (relative to the workspace root).
- Existing work-item input: `astraqa/data/management/d1a7e298b7dd68f42afb2425/work-items.json` (relative to the workspace root). It contains 190 COWORKLOCAL items; 16 have a nonempty description and none has a separate acceptance-criteria list.
- Source revision in both artifacts: `29aad09fe667dfc3d66770f9088dc03bd531af6e`.
- Analyze backend: `none`; 190 items, 185 `done`, 5 `missing`. No AgentLoop trace exists for this run.
- The current `none` implementation returns `done` whenever keyword evidence exists. This value means candidate presence in that backend; it is not an AC assessment.
- Stored verdicts: 121 `CODE_AHEAD`, 1 `JIRA_AHEAD`, 5 `MATCH`, 63 `NO_EVIDENCE`. Some rows were subsequently marked `ai`, so these totals are not a pure `none` backend measurement.

| Key | Jira status | Stored verdict | Tier | Evidence count | Why selected |
| --- | --- | --- | --- | ---: | --- |
| COWORKLOCAL-100 | in_progress | CODE_AHEAD | ai | 5 | Code candidate and non-Done Jira status |
| COWORKLOCAL-143 | in_progress | NO_EVIDENCE | grep | 0 | Exhaustive scan reported no candidate |
| COWORKLOCAL-2 | done | JIRA_AHEAD | grep | 0 | Done claim and no candidate |
| COWORKLOCAL-8 | done | MATCH | ai | 1 | Positive stored verdict with narrow evidence |
| COWORKLOCAL-9 | done | NO_EVIDENCE | ai | 5 | Evidence exists but judge did not confirm |

These five keys are regression examples, not ground-truth labels. The stored record does not include the complete original Jira payload or a CLI trace. A later quality comparison must replay the same Jira text and source SHA with AstraCode CLI and obtain human labels independently.

The five work-item content fingerprints (SHA-256 of JSON `[title, description, acceptance_criteria]`) are, in table order: `36d0f05fc067f0174dd85e381c8119ac6a318af72f7cce59687c177afa237304`, `74baed17a37d21b1debd606d737d7a0f2526f0565e131205c963fee387bf710b`, `14519e13c53fbc868b101abe331800a4d5604966662de58e910b902171ace41e`, `5c5c2a08d08afcb8d968ffc9a472e3a60e3bcc8d2b456ba85e02f82bac836744`, `2d9015f6b2441fecbb1cd44edc6889cc0144008cfcc50709a5ba5d8acd540527`. These identify the baseline input without copying ticket text into another file.

The transport regression fixture is two `## <key>` tickets, each with `### description` and `### acceptance criteria`. Before the fix, the heading parser chose level 3 because those subheadings occurred more often than level 2; it reported duplicate `description` and `acceptance criteria` keys. After the fix, both ticket keys and their full bodies must survive. The structured `tickets` request must preserve the same descriptions and AC as separate fields.
