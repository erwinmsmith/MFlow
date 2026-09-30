# MFlow implementation boundary

- Build all executable agents with the registry-published `@codesoul-co/ditto` package and its public exports.
- Never import a Ditto checkout, `src` or private `dist` modules; never use file/link/workspace dependencies, npm link, vendored runtime code, or patches to node_modules.
- The application owns organization policies, mutation grammar, deficit bookkeeping, datasets and statistical search. Ditto owns model execution, reasoning and tool execution.
- Record missing **general-purpose** package capabilities, reproduction steps and acceptance criteria in `docs/ditto-requirements.md`. Do not recreate missing Ditto infrastructure here.
- Test-only scripted ModelProviders are fixtures, not evidence of model or benchmark quality.
- Search and confirmation may affect selection. Test data must never enter search, mutation or agent prompts. Keep standard and continual protocols separate.
- Run `npm test` after changes to execution/search semantics. Do not run paid experiments without model configuration and an explicit experiment request.

# Server code consistency

- After code changes, run `bash scripts/sync_hb.sh` and require its checksum verification to pass before reporting completion. The local working tree is authoritative for `hb:/home/b/project/MFlow`.
- Keep server credentials, environments, datasets and experiment results outside code sync. If build, transfer or verification fails, fix it or clearly report that local and server code are not yet consistent; do not silently leave an older server snapshot.
