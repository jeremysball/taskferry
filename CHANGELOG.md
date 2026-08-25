# Changelog

## [4.4.0](https://github.com/jeremysball/taskferry/compare/taskferry-v4.3.0...taskferry-v4.4.0) (2026-08-25)


### Features

* **ci:** publish to npm via trusted publishing (OIDC) on release ([408f692](https://github.com/jeremysball/taskferry/commit/408f692adbe78fafbaf87a8e48755926f3e946ae))
* **ci:** publish to npm via trusted publishing (OIDC) on release ([70c362f](https://github.com/jeremysball/taskferry/commit/70c362f47d918bdb59ed8790d6b2c01d680750bf))
* **dispatch:** passthrough executor-native flags via --executor-arg ([78f58d7](https://github.com/jeremysball/taskferry/commit/78f58d782552ee19866fd1d295b31a0fefb2352b))
* **dispatch:** passthrough executor-native flags via --executor-arg ([0dd6c06](https://github.com/jeremysball/taskferry/commit/0dd6c06cabdc012922665ef75283c2d60fdfb8f8))


### Bug Fixes

* **ci:** publish with --provenance for OIDC trusted publishing ([bf59115](https://github.com/jeremysball/taskferry/commit/bf59115fb6dd63a4b703d850560948f29aa2cf7c))

## [4.3.0](https://github.com/jeremysball/taskferry/compare/taskferry-v4.2.0...taskferry-v4.3.0) (2026-08-23)


### Features

* **kilo:** add first-class Kilo Code integration with live monitoring ([a554780](https://github.com/jeremysball/taskferry/commit/a554780501496f87e8591b4f61ad583ea17cdc3e))


### Bug Fixes

* **skill:** regenerate kilo skill after main merge ([56d2a69](https://github.com/jeremysball/taskferry/commit/56d2a69ee67f67133d4c4c9fb8ad9811cf51ebb1))

## [4.2.0](https://github.com/jeremysball/taskferry/compare/taskferry-v4.1.2...taskferry-v4.2.0) (2026-08-22)


### Features

* **daemon:** auto-resume in-flight tasks on restart, restart immediately by default ([#502](https://github.com/jeremysball/taskferry/issues/502)) ([8777392](https://github.com/jeremysball/taskferry/commit/87773926b767f6a864f7fd4d1eee4dca6346c81c))
* **hooks:** enforce worktree commits via pre-commit gate ([7c1f6d6](https://github.com/jeremysball/taskferry/commit/7c1f6d6f2a926c472f87de7b118f34ffafc5250a))
* **hooks:** enforce worktree commits via pre-commit gate ([7c14397](https://github.com/jeremysball/taskferry/commit/7c14397413bed7662a036c92a452f2b0693c4206))
* **sandbox:** let --ro-bind override the deny-list with a loud warning ([#503](https://github.com/jeremysball/taskferry/issues/503)) ([a5a63b7](https://github.com/jeremysball/taskferry/commit/a5a63b7f4879c6aa92121527f93095d7d969a63c)), closes [#497](https://github.com/jeremysball/taskferry/issues/497)


### Bug Fixes

* **output:** enforce response budget for real request ids ([#527](https://github.com/jeremysball/taskferry/issues/527)) ([5acdc4f](https://github.com/jeremysball/taskferry/commit/5acdc4fea1eaaed4c0754f809db5140ecf094770))
* **sandbox,daemon,opencode:** per-task isolation for uv cache, daemon singleton, and XDG_DATA_HOME ([ffa5b3a](https://github.com/jeremysball/taskferry/commit/ffa5b3aa0c5b3ff3d7a1de99ed2f65c9f4574f1a))
* **sandbox,daemon,opencode:** per-task isolation for uv cache, daemon singleton, and XDG_DATA_HOME ([ed9713a](https://github.com/jeremysball/taskferry/commit/ed9713a122a660c3084ffae8a89d26d4e4dee6fb))
* **summarizer:** use latest session ID from retry logs ([0b845fd](https://github.com/jeremysball/taskferry/commit/0b845fd235eab08dc3d4d193ff4f243ecff18ae1))
* **tasks:** handle resolver failures and centralize activity-key normalization ([#483](https://github.com/jeremysball/taskferry/issues/483)) ([32ed725](https://github.com/jeremysball/taskferry/commit/32ed725b4b1106816d6251cf5d0c1761ee4fd3f2))

## [4.1.2](https://github.com/jeremysball/taskferry/compare/taskferry-v4.1.1...taskferry-v4.1.2) (2026-08-21)


### Bug Fixes

* **tooling:** glob test discovery and require local quality tools ([#528](https://github.com/jeremysball/taskferry/issues/528)) ([8f21442](https://github.com/jeremysball/taskferry/commit/8f2144238dd9216800ab9d312a955c2e14f9fd75))

## [4.1.1](https://github.com/jeremysball/taskferry/compare/taskferry-v4.1.0...taskferry-v4.1.1) (2026-08-21)


### Bug Fixes

* **adr:** correct kilo.md's actual location (PR [#489](https://github.com/jeremysball/taskferry/issues/489) branch, not main) ([f9aaf1f](https://github.com/jeremysball/taskferry/commit/f9aaf1ff62ae6eae5d65c045766623605fb78546))
* **executor:** resolve symlinked opencode config entries instead of dropping them ([#492](https://github.com/jeremysball/taskferry/issues/492)) ([bd4284a](https://github.com/jeremysball/taskferry/commit/bd4284a8c220d95286d8771d6a93327e94620cf2)), closes [#491](https://github.com/jeremysball/taskferry/issues/491)

## [4.1.0](https://github.com/jeremysball/taskferry/compare/taskferry-v4.0.0...taskferry-v4.1.0) (2026-08-16)


### Features

* **daemon:** add per-task writable scratch dir for durable deliverables ([#474](https://github.com/jeremysball/taskferry/issues/474)) ([434c075](https://github.com/jeremysball/taskferry/commit/434c075bd21215895029b35cc52c796b9c9ab164))


### Bug Fixes

* **cli:** accept exits nonzero on failed apply; result --diff size errors are actionable ([#472](https://github.com/jeremysball/taskferry/issues/472)) ([fdc2f94](https://github.com/jeremysball/taskferry/commit/fdc2f9423b5e839e230e4f512b7e8b290835a8df))
* **daemon:** cap list --all rows server-side so all-time history can't kill the connection ([#473](https://github.com/jeremysball/taskferry/issues/473)) ([2628f7d](https://github.com/jeremysball/taskferry/commit/2628f7d1d1555c29ccd256d335c8f119dea6b153))
* **daemon:** extract shared emptyStatusCounts helper ([#466](https://github.com/jeremysball/taskferry/issues/466)) ([4f28cce](https://github.com/jeremysball/taskferry/commit/4f28cce4836d35b8f29f96de7fc7e6203700c762))
* **daemon:** resolve workspace root before scheduleActivityFor's subscription lookup ([#479](https://github.com/jeremysball/taskferry/issues/479)) ([dd3e382](https://github.com/jeremysball/taskferry/commit/dd3e382835447b0d2ada1f165b1ac95adba6837e))
* **daemon:** reuse errorValue() in responseError() ([#467](https://github.com/jeremysball/taskferry/issues/467)) ([89b5fc7](https://github.com/jeremysball/taskferry/commit/89b5fc78b648b1d43ff413289e775ee4bb355542))
* **sandbox:** dedupe bwrap availability check logic ([#468](https://github.com/jeremysball/taskferry/issues/468)) ([84b4706](https://github.com/jeremysball/taskferry/commit/84b4706cc1e9ace6e240fc6e751c4af91dca004a))
* **sandbox:** persist overlay record before spawning the child ([#477](https://github.com/jeremysball/taskferry/issues/477)) ([8d56d61](https://github.com/jeremysball/taskferry/commit/8d56d61cdce0d763b194ad400bd296ba115f7954))
* **sandbox:** skip symlinked opencode config entries when ro-binding ([#475](https://github.com/jeremysball/taskferry/issues/475)) ([5a31a7c](https://github.com/jeremysball/taskferry/commit/5a31a7c5ebf4e1936097dd7f1e1c3c2f6088b46f))
* **sandbox:** snapshot a worktree's private gitDir instead of live-overlaying it ([#476](https://github.com/jeremysball/taskferry/issues/476)) ([df2ccb6](https://github.com/jeremysball/taskferry/commit/df2ccb6d835ad1ea610b9a44e22d57964e34dedd))
* **skills:** resume the prior ferry's session for follow-up work ([#465](https://github.com/jeremysball/taskferry/issues/465)) ([3a8230a](https://github.com/jeremysball/taskferry/commit/3a8230a9ffe46a0b7cfb07414a8b0b885972797b))

## [4.0.0](https://github.com/jeremysball/taskferry/compare/taskferry-v3.2.0...taskferry-v4.0.0) (2026-08-12)


### ⚠ BREAKING CHANGES

* **tasks:** dispatch() and buildDispatchTask() no longer fall back to a hardcoded per-executor default model (pi's minimax default, opencode's luna default) when --model is omitted. A fresh dispatch (no --model, no resolvable --session-id to inherit a model from) now throws "error: --model is required"; an unresolvable --session-id with no --model throws naming the session id. WorkerExecutor's defaultModel field is removed.

### Features

* **sandbox:** add --ro-bind, rename --allowed-dirs to --rw-bind ([#401](https://github.com/jeremysball/taskferry/issues/401)) ([bdbd8c8](https://github.com/jeremysball/taskferry/commit/bdbd8c85bdbcc205101ed298d29e516f139ef74d))
* **tasks:** require --model on dispatch, default omitted --variant to highest-thinking ([#435](https://github.com/jeremysball/taskferry/issues/435)) ([fd1b2f5](https://github.com/jeremysball/taskferry/commit/fd1b2f5fbb59d33f66fc80deaa766e96ed1b863a))
* **types:** typecheck the whole of src/, not just tasks.js ([#400](https://github.com/jeremysball/taskferry/issues/400)) ([b56fb3f](https://github.com/jeremysball/taskferry/commit/b56fb3f55686ab2c0b144de5ce37b596949aa158))


### Bug Fixes

* **sandbox:** narrow the runtime-dir bind to the daemon socket only ([#457](https://github.com/jeremysball/taskferry/issues/457)) ([070f32c](https://github.com/jeremysball/taskferry/commit/070f32cce8ec60e2aede8b598c84e6cc240a3115))
* **skills:** correct four defects in using-taskferry and add executable tests ([085ef7c](https://github.com/jeremysball/taskferry/commit/085ef7cbd1f0e2a0d5f00ea19d78f30642b64551))
* **tasks:** tighten parseNumstatLine to reject non-integer/non-finite numstat tokens ([#417](https://github.com/jeremysball/taskferry/issues/417)) ([ee0184f](https://github.com/jeremysball/taskferry/commit/ee0184f1003c81f4d592de16bce8443b1bf88bd9))
* **tests:** remove the undefined/ gitignore bandaid at its root ([#463](https://github.com/jeremysball/taskferry/issues/463)) ([02d637d](https://github.com/jeremysball/taskferry/commit/02d637d5b2aae48e9d6bfc8e7e4129eab5e00cfa))


### Skills

* **skills:** split using-taskferry into SKILL.md plus resources, dropping the private-only skill dependencies ([#446](https://github.com/jeremysball/taskferry/issues/446)) ([230fc77](https://github.com/jeremysball/taskferry/commit/230fc77a208495a1e7bb713cbbcf1327fb1ca424))
* **skills:** flag that bare --timeout values are milliseconds ([#407](https://github.com/jeremysball/taskferry/issues/407)) ([29ae066](https://github.com/jeremysball/taskferry/commit/29ae06629cb37d3fe712d734e457ccb169b9ba2e))


### Performance Improvements

* **statusline:** cache Taskferry refreshes ([#441](https://github.com/jeremysball/taskferry/issues/441)) ([ab50d93](https://github.com/jeremysball/taskferry/commit/ab50d93f4241189dddfe39f46b764d61a21bf9fa))


### Refactors

* **statusline:** tf-sl emits raw fields, dropping width/mode rendering ([#445](https://github.com/jeremysball/taskferry/issues/445)) ([99f3576](https://github.com/jeremysball/taskferry/commit/99f357681be80573506a17a3040d266a5e910c2c))

## [3.2.0](https://github.com/jeremysball/taskferry/compare/taskferry-v3.1.0...taskferry-v3.2.0) (2026-08-09)


### Features

* **tasks:** per-provider concurrency and dispatch-rate limits ([#413](https://github.com/jeremysball/taskferry/issues/413)) ([f2ce2c4](https://github.com/jeremysball/taskferry/commit/f2ce2c496befed2cd013cc9a00595ea0cee83254))

## [3.1.0](https://github.com/jeremysball/taskferry/compare/taskferry-v3.0.0...taskferry-v3.1.0) (2026-08-07)


### Features

* .taskferry.toml project config with settle-time verification gate ([#352](https://github.com/jeremysball/taskferry/issues/352)) ([f0b09ba](https://github.com/jeremysball/taskferry/commit/f0b09baafeb3380ffa590bbdb763d1afe0d90c5d))
* **cli:** prettified TTY output via a shape-based renderer ([#367](https://github.com/jeremysball/taskferry/issues/367)) ([566a331](https://github.com/jeremysball/taskferry/commit/566a331e69f5748085bf7ffaa02d5574f2fc3ebc))
* **dispatch:** tranche 2 telemetry instrumentation (--class tag + finalStatus parsing) ([#340](https://github.com/jeremysball/taskferry/issues/340)) ([5b3f837](https://github.com/jeremysball/taskferry/commit/5b3f837b48e98fde521a2a4623bb4374ad811254))
* stale-base 3-way apply and honest terminal status ([#353](https://github.com/jeremysball/taskferry/issues/353)) ([ee6ce40](https://github.com/jeremysball/taskferry/commit/ee6ce40f2702a433201e1854a3ece7a43f39960e))


### Bug Fixes

* **changeset:** re-check HEAD after retry and inject a fast test sleepFn ([#333](https://github.com/jeremysball/taskferry/issues/333)) ([af62f76](https://github.com/jeremysball/taskferry/commit/af62f760bfa2422e2eba191cf2fcb73df7c010ce))
* **changeset:** retry extraction bwrap on the overlay-mount-busy race ([#326](https://github.com/jeremysball/taskferry/issues/326)) ([#327](https://github.com/jeremysball/taskferry/issues/327)) ([9c94513](https://github.com/jeremysball/taskferry/commit/9c945131fc70e77af70ae8bdf645ecab79ff0907))
* **changeset:** set an explicit maxBuffer on defaultRunCommand's spawnSync ([#361](https://github.com/jeremysball/taskferry/issues/361)) ([44e657e](https://github.com/jeremysball/taskferry/commit/44e657ef7c7cd65d272ca4ded0b0077c594570db))
* **ci:** collapse check workflow into a single job to fix runner contention ([0080dea](https://github.com/jeremysball/taskferry/commit/0080deae0889e96572b299c864c0f47356caf428))
* **daemon:** doctor --stats connection-closed bug + doctor output formatting ([#332](https://github.com/jeremysball/taskferry/issues/332)) ([89988a3](https://github.com/jeremysball/taskferry/commit/89988a342643b13248d210170e8bdb48c6c7318c))
* **daemon:** make watch/list/context directory filtering worktree-aware, add watch --all ([#334](https://github.com/jeremysball/taskferry/issues/334)) ([2d5c286](https://github.com/jeremysball/taskferry/commit/2d5c28609927ce83c85d2ea9f088bb69a8eb2d71)), closes [#315](https://github.com/jeremysball/taskferry/issues/315)
* **npm:** ship scripts/generate-skill.js in the published package ([#393](https://github.com/jeremysball/taskferry/issues/393)) ([30eefc8](https://github.com/jeremysball/taskferry/commit/30eefc88e7203750560293740475065dab92a075))
* **output:** trim overlayDirs internals out of `status --full` ([#330](https://github.com/jeremysball/taskferry/issues/330)) ([b806ae4](https://github.com/jeremysball/taskferry/commit/b806ae4f8354cd08d857ed9fb3d2b95568002a98))
* **sandbox:** give opencode a writable config home inside the sandbox ([#390](https://github.com/jeremysball/taskferry/issues/390)) ([f49d787](https://github.com/jeremysball/taskferry/commit/f49d787bf6efa6cf6a32401c6984d0b5685b8d72))
* **tasks:** close remaining gaps in the any-growth watchdog activity signal ([#360](https://github.com/jeremysball/taskferry/issues/360)) ([062563c](https://github.com/jeremysball/taskferry/commit/062563ce2501b5c3428d768691e0d6d9feced841))
* **tasks:** match --require-final-marker across a multi-paragraph message ([#339](https://github.com/jeremysball/taskferry/issues/339)) ([49d896a](https://github.com/jeremysball/taskferry/commit/49d896ad1e0253ac5648aab2b23b0664f19d7ca1))
* **tasks:** split no_output_timeout by output-seen, recover crashed-but-completed tasks ([#345](https://github.com/jeremysball/taskferry/issues/345)) ([2860818](https://github.com/jeremysball/taskferry/commit/2860818f95f1ed6fc9a1210bec5a5cdba29ebd63))
* **test:** route integration smoke tests through OpenRouter, not direct minimax ([#364](https://github.com/jeremysball/taskferry/issues/364)) ([e0056ed](https://github.com/jeremysball/taskferry/commit/e0056ed2b348bc180c710b0a2e7f0e52878ac108))
* **tests:** close the test-suite's own /tmp temp-dir leak ([#368](https://github.com/jeremysball/taskferry/issues/368)) ([cc5cecc](https://github.com/jeremysball/taskferry/commit/cc5cecc031130acf4dbb97fdd93c819ed4587da9))

## [3.0.0](https://github.com/jeremysball/taskferry/compare/taskferry-v2.1.0...taskferry-v3.0.0) (2026-08-04)


### ⚠ BREAKING CHANGES

* **lint:** lint warnings that used to be informational now block commits (pre-commit hook) and CI (check.yml's lint leg). Any future sonarjs or maintainability-rule violation must be fixed before merging, not just noted.

### Features

* **advisor:** auto-attach caller context, --summarize-context (advisor-context-dump plan) ([#266](https://github.com/jeremysball/taskferry/issues/266)) ([7c6e69e](https://github.com/jeremysball/taskferry/commit/7c6e69eaed560d27aa4b8fa5f21b829650534633))
* **args:** duration-string flags ([#223](https://github.com/jeremysball/taskferry/issues/223)) ([22067f3](https://github.com/jeremysball/taskferry/commit/22067f316dac109548196a993b3640da14476188))
* **config:** add TASKFERRY_ENV_FILE for non-interactive callers with missing secrets ([#284](https://github.com/jeremysball/taskferry/issues/284)) ([3fec57d](https://github.com/jeremysball/taskferry/commit/3fec57d9f0c64c190d9123d8696af452418c53c7))
* **config:** live-reload TASKFERRY_ENV_FILE/envFile instead of requiring a restart ([#291](https://github.com/jeremysball/taskferry/issues/291)) ([88a9387](https://github.com/jeremysball/taskferry/commit/88a9387d3d4e31e2f7b2f5a6f02c05ac755e7c80))
* **config:** live-reload TASKFERRY_ENV_FILE/envFile instead of requiring a restart ([#320](https://github.com/jeremysball/taskferry/issues/320)) ([1521f5d](https://github.com/jeremysball/taskferry/commit/1521f5d5bdeedc9f09df6346a4960740df2f2bf6))
* **daemon:** opt-in request-latency profiling with log rotation ([#301](https://github.com/jeremysball/taskferry/issues/301)) ([6232710](https://github.com/jeremysball/taskferry/commit/6232710d57d60caf227c6ea2ee702be202c75354))
* **doctor:** add taskferry doctor --stats ([#272](https://github.com/jeremysball/taskferry/issues/272)) ([881107e](https://github.com/jeremysball/taskferry/commit/881107ebfa572329207b1aee917770818bf6cd55))
* **executor:** make pi the default executor instead of opencode ([#198](https://github.com/jeremysball/taskferry/issues/198)) ([97a5497](https://github.com/jeremysball/taskferry/commit/97a5497dc10883a3d24a844da3eeb8a83c877ae5))
* **fleet-monitor:** git-workspace-scoped directory defaults + watch --flush-interval ([#225](https://github.com/jeremysball/taskferry/issues/225)) ([fbb5694](https://github.com/jeremysball/taskferry/commit/fbb56944a4a3b16e889c92aa0121fdcba1408ce5))
* replace key-slot system with caller-env forwarding ([#241](https://github.com/jeremysball/taskferry/issues/241)) ([656d9da](https://github.com/jeremysball/taskferry/commit/656d9dafe627978722d4dc0f05268efe2d033483))
* **sandbox:** copy-on-write overlays and diff-gated writes ([#251](https://github.com/jeremysball/taskferry/issues/251)) ([032ac5b](https://github.com/jeremysball/taskferry/commit/032ac5b6e0bfe852a6c2b5d4382136db78f2485e))


### Bug Fixes

* **advisor:** correct misleading transcript-error hint about --prompt ([ddf63fd](https://github.com/jeremysball/taskferry/commit/ddf63fdb6f6801bd1d9a6e64de26f56937011a2f))
* **advisor:** extract only user/assistant text from the Claude transcript ([#295](https://github.com/jeremysball/taskferry/issues/295)) ([f3b1d9d](https://github.com/jeremysball/taskferry/commit/f3b1d9d2242ed33a8690dcd9a55d38687cf1c98b))
* **advisor:** prompt caller's --prompt ahead of canned pushback framing ([#271](https://github.com/jeremysball/taskferry/issues/271)) ([653fea6](https://github.com/jeremysball/taskferry/commit/653fea66ddfc7f63ee1ddaac15dd50edd9d3061f))
* cap unbounded task-list payloads and settle advisor changesets correctly ([#297](https://github.com/jeremysball/taskferry/issues/297)) ([dc6177d](https://github.com/jeremysball/taskferry/commit/dc6177d288dae44630a391424afc800700248257))
* **changeset:** overlay cleanup can't strand upper/ on kernel whiteout ([#278](https://github.com/jeremysball/taskferry/issues/278)) ([1f06572](https://github.com/jeremysball/taskferry/commit/1f06572a43b358a6c1fcffc0afd4f3530b0eb50e))
* **changeset:** refuse to extract a diff when the directory's HEAD has moved since dispatch ([#262](https://github.com/jeremysball/taskferry/issues/262)) ([c054dfa](https://github.com/jeremysball/taskferry/commit/c054dfa0d5d2811d86c4989bcf3c68fad6a99d41))
* **commands:** report real package version in doctor --full output ([#306](https://github.com/jeremysball/taskferry/issues/306)) ([2db1081](https://github.com/jeremysball/taskferry/commit/2db108114b7ff80385a6ae1447499f91a079a3dd))
* **daemon:** back off between prepareSocket retries to stop a busy-spin under boot contention ([#285](https://github.com/jeremysball/taskferry/issues/285)) ([b5789cd](https://github.com/jeremysball/taskferry/commit/b5789cd39b6a52e14ad78b41290d1f91f6c49330))
* **daemon:** forward whole params to task.wait/task.result instead of rebuilding field lists ([#296](https://github.com/jeremysball/taskferry/issues/296)) ([7da0f91](https://github.com/jeremysball/taskferry/commit/7da0f9128debaa31c7bb9151af517fbdbdf08f91)), closes [#246](https://github.com/jeremysball/taskferry/issues/246)
* **daemon:** stop task.list/context from scanning every historical task ([#294](https://github.com/jeremysball/taskferry/issues/294)) ([4d6c4cf](https://github.com/jeremysball/taskferry/commit/4d6c4cfcd67d3cbccef9e525bfca064f176d510d))
* **daemon:** treat XDG_RUNTIME_DIR as canonical even when unexported ([#280](https://github.com/jeremysball/taskferry/issues/280)) ([08be50a](https://github.com/jeremysball/taskferry/commit/08be50aee8a23125cf2cb33061f61b003ba761c5))
* **lint:** promote sonarjs and maintainability rules to hard errors ([#303](https://github.com/jeremysball/taskferry/issues/303)) ([9a0a390](https://github.com/jeremysball/taskferry/commit/9a0a39070a1c8ce2652839b1c82e01ba9d7775c9))
* **mcp-isolation:** stop stripJsonComments's string match from crossing lines ([#310](https://github.com/jeremysball/taskferry/issues/310)) ([de786e0](https://github.com/jeremysball/taskferry/commit/de786e0ad89063081524e3114ab5113ff9a9ba7f))
* **release:** sync plugin manifests to 2.1.0, wire into release-please ([#240](https://github.com/jeremysball/taskferry/issues/240)) ([f48ef2f](https://github.com/jeremysball/taskferry/commit/f48ef2f5ab2ec63173c5f723de2d209d5697b6cc))
* **sandbox:** bind writable git-common-dir files as scratch copies, not sub-overlays ([#259](https://github.com/jeremysball/taskferry/issues/259)) ([498952c](https://github.com/jeremysball/taskferry/commit/498952cdc275fc40d5308a60930fee444ac0441e))
* **sandbox:** deny ~/.claude by default, make the deny-list configurable ([#264](https://github.com/jeremysball/taskferry/issues/264)) ([9da0167](https://github.com/jeremysball/taskferry/commit/9da0167386d35250d5069ddeb2122b1f37e1a4d3))
* **sandbox:** scope a worktree dispatch's git-common-dir bind to shared data only ([#227](https://github.com/jeremysball/taskferry/issues/227)) ([26309e4](https://github.com/jeremysball/taskferry/commit/26309e4499d51ce8a4f71bf9ef02bad95e1ef9e7))
* **sandbox:** stop unsharing network on advisor spawns ([#257](https://github.com/jeremysball/taskferry/issues/257)) ([e017001](https://github.com/jeremysball/taskferry/commit/e017001a57936098f4e49ab140f041a64b9a2b30))
* **setup:** tighten managed-symlink guard to the exact checkout in use ([#213](https://github.com/jeremysball/taskferry/issues/213)) ([2949f04](https://github.com/jeremysball/taskferry/commit/2949f04874cbd867def5978091e7c13f7bc472a3))
* **skill:** disambiguate the fleet-watch log path per workspace ([#268](https://github.com/jeremysball/taskferry/issues/268)) ([1303b9a](https://github.com/jeremysball/taskferry/commit/1303b9a9ed28570a1fa83d8ce7c1afb211c526bf))
* **statusline:** never let tf-sl trigger daemon autostart ([#279](https://github.com/jeremysball/taskferry/issues/279)) ([1886fdf](https://github.com/jeremysball/taskferry/commit/1886fdf7c94c06884da11c6f9c8d56fe63c2b464))
* **tasks:** debounce persistTask() writes instead of full rewrite per transition ([#298](https://github.com/jeremysball/taskferry/issues/298)) ([2d75153](https://github.com/jeremysball/taskferry/commit/2d751534fb219a5701d306326f5267ebf9746c5d)), closes [#55](https://github.com/jeremysball/taskferry/issues/55)
* **tasks:** scope overlayTmpRoot under runtimeDir to stop cross-daemon sweep collisions ([#288](https://github.com/jeremysball/taskferry/issues/288)) ([e5be588](https://github.com/jeremysball/taskferry/commit/e5be588bdbe152f96ef9060a34d3d208dfa6a7e0))
* **tasks:** stagger launches globally and surface overlay_mount_busy ([#318](https://github.com/jeremysball/taskferry/issues/318)) ([#321](https://github.com/jeremysball/taskferry/issues/321)) ([285c7a3](https://github.com/jeremysball/taskferry/commit/285c7a3e6df4a47dd81814c99185091dc5e4872b))
* **tasks:** stop overlay tests from scanning and acting on real host /tmp ([#258](https://github.com/jeremysball/taskferry/issues/258)) ([04d5e48](https://github.com/jeremysball/taskferry/commit/04d5e48dd5114ff41b7c84b6226b70f7133fb02b))
* **tasks:** surface boot-crash stderr as failureReason instead of silent null ([#255](https://github.com/jeremysball/taskferry/issues/255)) ([f9f279f](https://github.com/jeremysball/taskferry/commit/f9f279f2ae3d9b131ea39825722c9966cceacca0))


### Performance Improvements

* **activity:** hoist sanitizeActivityText's regexes to module scope ([#307](https://github.com/jeremysball/taskferry/issues/307)) ([b232985](https://github.com/jeremysball/taskferry/commit/b2329856924b5f576bd99b795e9460a99d84288a))
* **config:** cache parsed config instead of re-reading on every call ([#276](https://github.com/jeremysball/taskferry/issues/276)) ([52eaac9](https://github.com/jeremysball/taskferry/commit/52eaac993daced92982274ab4ed94a7771c4df07))
* **tasks:** build filtered env in one pass instead of spread+delete ([#275](https://github.com/jeremysball/taskferry/issues/275)) ([edd2111](https://github.com/jeremysball/taskferry/commit/edd2111f6013207240c72166b416ae86675588f2))

## [2.1.0](https://github.com/jeremysball/taskferry/compare/taskferry-v2.0.0...taskferry-v2.1.0) (2026-07-28)


### Features

* **activity:** include truncated tool calls in narration summaries ([a51e000](https://github.com/jeremysball/taskferry/commit/a51e000216871e1cda24cf70f9f5e3256b46c619))
* add opencode_cancel and opencode_wait tools ([b3d2535](https://github.com/jeremysball/taskferry/commit/b3d2535220297dfa29de809facf559422897f9b3))
* **claude:** add task activity monitor plugin ([7ab86d3](https://github.com/jeremysball/taskferry/commit/7ab86d33fc8956f1c1cb0078556826a985deb42b))
* **cli:** add wait --summarize for live periodic progress summaries ([91b2469](https://github.com/jeremysball/taskferry/commit/91b2469307ada248cbc1557a002b649f20418a48))
* **cli:** add watch --task-id to scope live streaming to one task ([4646d4d](https://github.com/jeremysball/taskferry/commit/4646d4db545a2448db2a1317b2ee6d14cc9f2aa6))
* **cli:** bootstrap local setup ([df72c2e](https://github.com/jeremysball/taskferry/commit/df72c2e9e1e8760205d93df6833e6e40a8c13d4b))
* **cli:** replace MCP server with AXI commands ([839526f](https://github.com/jeremysball/taskferry/commit/839526f17a2d507b38900800450eb38970a5788f))
* **cli:** watch --task-id, wait --summarize, local setup, and wait-hang fixes ([cfc45cc](https://github.com/jeremysball/taskferry/commit/cfc45cc0900f3d5ffb9a46b5dd6e74af7ac05409))
* **cli:** wire WorkerExecutor through startTask and CLI ([#121](https://github.com/jeremysball/taskferry/issues/121)) ([bd5dfcb](https://github.com/jeremysball/taskferry/commit/bd5dfcb56c516d6a324b55569d5e226a9edcb2b3))
* **codex:** add lifecycle context plugin ([f1f5674](https://github.com/jeremysball/taskferry/commit/f1f5674fc86f6f4d6c552af2182a8aa96bb43bc6))
* **commands:** filter streamTaskEvents to one task and auto-resolve on its terminal event ([d93b356](https://github.com/jeremysball/taskferry/commit/d93b356dda5a350ab582138cd40b72d0d865ad8c))
* **config:** add JSON config file with env &gt; config &gt; default precedence ([#41](https://github.com/jeremysball/taskferry/issues/41)) ([4163130](https://github.com/jeremysball/taskferry/commit/4163130a580a67348845c6da2816f4413126542b))
* **config:** promote wait timeout, cancel grace, and default executor to config ([#122](https://github.com/jeremysball/taskferry/issues/122)) ([1726e1d](https://github.com/jeremysball/taskferry/commit/1726e1d29feb6cc2db07562a0d244f3ca4efca9d))
* **core:** emit task lifecycle events ([c8742df](https://github.com/jeremysball/taskferry/commit/c8742df17742de7199fa5de100978cb32b7eff45))
* **daemon:** add idle-deferred self-restart on source change ([914d486](https://github.com/jeremysball/taskferry/commit/914d486a93e77a3fcd54fdc0ac8bf84e4d6c39f7))
* **daemon:** add persistent local task service ([5428d6f](https://github.com/jeremysball/taskferry/commit/5428d6f578898f210bcdad478a295b791813f70e))
* **doctor:** add Playwright MCP isolation checks and repairs ([#76](https://github.com/jeremysball/taskferry/issues/76)) ([5c83d0a](https://github.com/jeremysball/taskferry/commit/5c83d0ab04e2d473ef0319b9844724a265f11e5e))
* **events:** add summarized task activity streams ([a6b621a](https://github.com/jeremysball/taskferry/commit/a6b621a1f4a46e4468989d2f372706f1c56c5ab4))
* **executor:** add WorkerExecutor abstraction foundation ([#119](https://github.com/jeremysball/taskferry/issues/119)) ([f929719](https://github.com/jeremysball/taskferry/commit/f92971908d477d8137a66ef8342515b95ab7e124))
* lean tool output + CI/lint/typecheck quality gates ([#7](https://github.com/jeremysball/taskferry/issues/7)) ([95416d5](https://github.com/jeremysball/taskferry/commit/95416d51ac591db9a9dd7043e885b187e05759f2))
* **opencode:** add native task activity plugin ([19d7185](https://github.com/jeremysball/taskferry/commit/19d7185e8855ba4fa479c3481774d36521eecf63))
* **output:** colorize status text when writing to a TTY ([8a472a1](https://github.com/jeremysball/taskferry/commit/8a472a154b378e3b78fbabeb8189a754326dd200))
* rename summary --style to --mode; fail fast on summarizer failure ([#72](https://github.com/jeremysball/taskferry/issues/72)) ([fab05e1](https://github.com/jeremysball/taskferry/commit/fab05e174bf628b4434c21cf421b0e53b087f2ce))
* replace taskferry MCP server with persistent AXI CLI ([cde4e6a](https://github.com/jeremysball/taskferry/commit/cde4e6ad75a59227ddc264603880cbb49f400448))
* **server:** expose opencode_dispatch/status/result/list as MCP tools ([1d37875](https://github.com/jeremysball/taskferry/commit/1d378756bf6a12a65053a82adbe95e0b8690c836))
* **setup:** bootstrap local CLI, symlinks, and native integrations ([#22](https://github.com/jeremysball/taskferry/issues/22)) ([3afed6e](https://github.com/jeremysball/taskferry/commit/3afed6eae08f70b9cbe930e931ce72ae94ad1a64))
* **setup:** canonize taskferry statusline segment as tf-sl ([#74](https://github.com/jeremysball/taskferry/issues/74)) ([e4a55f6](https://github.com/jeremysball/taskferry/commit/e4a55f6223621736c7a457d5f1aa2445db8a37b8))
* **setup:** install local integrations ([1d46a60](https://github.com/jeremysball/taskferry/commit/1d46a60047c20fddf89433805e4abd3db425073e))
* **skills:** rename taskferry skill to using-taskferry ([3b95587](https://github.com/jeremysball/taskferry/commit/3b955877ded58447948483b98d8e8d746ab73605))
* **status:** report log write activity to spot stuck tasks ([#4](https://github.com/jeremysball/taskferry/issues/4)) ([7503c6d](https://github.com/jeremysball/taskferry/commit/7503c6dc33f2ecd00a8b7b9a131de2b0d9d2a12c))
* **taskferry:** add taskferry_advisor, rename taskferry_wait to taskferry_poll ([#5](https://github.com/jeremysball/taskferry/issues/5)) ([0d944df](https://github.com/jeremysball/taskferry/commit/0d944df847cd91345e4abd7910d2efc26e4ab76b))
* **taskferry:** dispatch reliability - locking, concurrency cap, watchdog, key slots ([#6](https://github.com/jeremysball/taskferry/issues/6)) ([cbf670a](https://github.com/jeremysball/taskferry/commit/cbf670ae2eaf3817c76b1e269521957c7c244606))
* **tasks:** add background dispatch, status, and result tracking for opencode runs ([333d255](https://github.com/jeremysball/taskferry/commit/333d2551d134cb400d884bbcccccf27bfe0d9cbd))
* **tasks:** escalate no-output watchdog after first log event ([b36158d](https://github.com/jeremysball/taskferry/commit/b36158d5ae2cdd551d02780259586bc8d656209f))
* **tasks:** plumb post-output no-output timeout option ([a371a13](https://github.com/jeremysball/taskferry/commit/a371a139e00aa30cc7bdf0d7fcccf3c49e21616e))
* **tasks:** switch tool output to TOON and add dependency-injected test coverage ([a5a3933](https://github.com/jeremysball/taskferry/commit/a5a3933f7bb0e38571e34e8b3857b6b5d563b351))
* **wait:** include output tail on timeout ([1344947](https://github.com/jeremysball/taskferry/commit/1344947929de331a194cd497622976e502c963b9))


### Bug Fixes

* **activity:** reduce default activity-summary call rate ([be375c6](https://github.com/jeremysball/taskferry/commit/be375c6de777367f4452331f8570ac94c2bfb44f))
* **activity:** route each subscriber its own requested summary variant ([191b066](https://github.com/jeremysball/taskferry/commit/191b0665c40eeef309dc022341b5dea75fc82327))
* **activity:** route each subscriber its own requested summary variant ([9726d5a](https://github.com/jeremysball/taskferry/commit/9726d5add23cff8c07125e51477a99c3290a9eca))
* **advisor:** report actual queued/running status instead of hardcoding running ([7c3c9dd](https://github.com/jeremysball/taskferry/commit/7c3c9dd927dc44824912e8114b68d54272e21c75))
* **claude:** quote CLAUDE_PROJECT_DIR correctly in the SessionStart hook ([41f9698](https://github.com/jeremysball/taskferry/commit/41f969834c93f731fbde0a2525a6c48df0396b5a))
* **claude:** report a structured error when taskferry context fails ([59f0f14](https://github.com/jeremysball/taskferry/commit/59f0f14545fcf05fbcb330e6d50fa536731a4b01))
* **cleanup:** consolidate duplicated dir/error/narration/number helpers ([#43](https://github.com/jeremysball/taskferry/issues/43)) ([156965b](https://github.com/jeremysball/taskferry/commit/156965b86bbef0157430381b50dd951d347695b2))
* **cli:** migrate stale MCP hints in active result output ([354e43e](https://github.com/jeremysball/taskferry/commit/354e43e8fae6ff6f4d566989a9736fd1c7618dc8))
* **cli:** resolve symlinked entrypoint before the direct-execution guard ([b208bc2](https://github.com/jeremysball/taskferry/commit/b208bc2e00a4d0e5f9daa45a359dbf5ed1fb6699))
* **commands:** address final review findings on wait --summarize ([e7fc063](https://github.com/jeremysball/taskferry/commit/e7fc0636023d431ae8428597798fb0d7c0d03e29))
* **commands:** print terminal event before resolving in streamTaskEvents ([caaa8a5](https://github.com/jeremysball/taskferry/commit/caaa8a59539a261c6d6acd000c59c37afe514e74))
* **commands:** resolve wait --summarize and watch --task-id hangs on settled tasks ([44b12c7](https://github.com/jeremysball/taskferry/commit/44b12c7a5e47fb326bd1acef365b349f565829fd))
* **commands:** use tmpdir instead of hardcoded path in commands.test.js ([3c548d6](https://github.com/jeremysball/taskferry/commit/3c548d653a0c382c010d40015f7f857d30608c8f))
* **commands:** warn in doctor when the Claude plugin isn't installed ([#26](https://github.com/jeremysball/taskferry/issues/26)) ([3b58e6f](https://github.com/jeremysball/taskferry/commit/3b58e6fd171672bb3be85e5e391ffcd3e039129b))
* **core:** guard onEvent failure diagnostic against its own errors ([187e781](https://github.com/jeremysball/taskferry/commit/187e78163003d2596245a1af4f245ac5ca59b960))
* **core:** surface swallowed onEvent observer failures ([067b67d](https://github.com/jeremysball/taskferry/commit/067b67d77af2a1b822ca94273ebb3c76901b1ed6))
* **daemon:** close inode-reuse race in stale-socket identity check ([899c37f](https://github.com/jeremysball/taskferry/commit/899c37f6a8f5ba7a285ad6efaa69cd35c65ff427))
* **daemon:** detached-boot auto-start, drop redundant OPENCODE_DB override ([#129](https://github.com/jeremysball/taskferry/issues/129)) ([8e32f7e](https://github.com/jeremysball/taskferry/commit/8e32f7e01b3aed339a5eb937a2cef0596e3c3ddb))
* **daemon:** remove unreachable setActivitySummarySubscriptions fallback ([#105](https://github.com/jeremysball/taskferry/issues/105)) ([0846614](https://github.com/jeremysball/taskferry/commit/0846614627542d7b6d827ff776070a35ee749450))
* **daemon:** stop destroying sockets on backpressure ([455758e](https://github.com/jeremysball/taskferry/commit/455758ea708580d021f6ef89aa2b317768e5fec8))
* **dispatch:** resolve prompt-size, credential, and trailing-error failures ([#83](https://github.com/jeremysball/taskferry/issues/83)) ([1a4f646](https://github.com/jeremysball/taskferry/commit/1a4f6465642a3d68060d468fbff88904a9f672c3))
* **executor:** set OPENCODE_DB in sandbox env so opencode uses isolated DB ([d45428b](https://github.com/jeremysball/taskferry/commit/d45428b41338613ad57cac1dfeed0cbb5499a3a0))
* **executor:** set OPENCODE_DB in sandbox env so opencode uses isolated DB ([d4f9b79](https://github.com/jeremysball/taskferry/commit/d4f9b791f00dc161ceefca6426028da9057fb8a7))
* issue triage batch 1 (crash-safety, memory leak, stdin hang, shell injection) ([#194](https://github.com/jeremysball/taskferry/issues/194)) ([37acdee](https://github.com/jeremysball/taskferry/commit/37acdeee458ee3df81bf97f3b89491442fb9c23b))
* **plan:** address advisor review findings on sonarjs lint ratchet plan ([07236fc](https://github.com/jeremysball/taskferry/commit/07236fcf4d8bcae74de8aa4e3f6ae6c4c215abfb))
* **sandbox:** bind a git worktree's real gitdir read-write, add allowedDirs ([#111](https://github.com/jeremysball/taskferry/issues/111)) ([bdab274](https://github.com/jeremysball/taskferry/commit/bdab274a27e0b77ddb61ea5ec603cd53083b7926))
* **sandbox:** bind pi's real extensions dir read-only into the sandbox ([#142](https://github.com/jeremysball/taskferry/issues/142)) ([eb53402](https://github.com/jeremysball/taskferry/commit/eb534027995080c224e1ecd7d88dfeb18c371e8a)), closes [#124](https://github.com/jeremysball/taskferry/issues/124)
* **setup:** normalize defaultRunCommandAsync's exit-code shape to match spawnSync ([#215](https://github.com/jeremysball/taskferry/issues/215)) ([c52da51](https://github.com/jeremysball/taskferry/commit/c52da51a0b81a95335cdd5b430b36c1b22d4a39f))
* **setup:** use git-hash comparison to detect stale Claude plugin installs ([#64](https://github.com/jeremysball/taskferry/issues/64)) ([6b1f143](https://github.com/jeremysball/taskferry/commit/6b1f1436170c634710de2974e5ac8e8ce64d7d7a))
* **taskferry:** address remaining GLM-5.2 review findings from PR [#6](https://github.com/jeremysball/taskferry/issues/6) ([#8](https://github.com/jeremysball/taskferry/issues/8)) ([8a3b3d6](https://github.com/jeremysball/taskferry/commit/8a3b3d678405e71cd2cdfb72ac768c5a4364b272))
* **taskferry:** close activity, summary-wait, and terminal-task edge cases ([f1e5b99](https://github.com/jeremysball/taskferry/commit/f1e5b994860545e2bcd7e247d2aa90981c240d72))
* **tasks,commands:** restore ambient summary key on collision, skip aborted trailing status RPC ([403fbf5](https://github.com/jeremysball/taskferry/commit/403fbf50481a83cb7fd4cd4c5a8ada7ac86621da))
* **tasks,commands:** summary key-collision restore and abort-skip trailing status RPC ([2a2fc44](https://github.com/jeremysball/taskferry/commit/2a2fc44b6ab611cd530b41296969eb04d7c952f6))
* **tasks,output:** make streamed activity summaries diff-aware and compact ([#28](https://github.com/jeremysball/taskferry/issues/28)) ([3613218](https://github.com/jeremysball/taskferry/commit/3613218359210e7332f1abafe21d91264023486b))
* **tasks:** classify unrecognized structured error events ([#68](https://github.com/jeremysball/taskferry/issues/68)) ([2ec78a7](https://github.com/jeremysball/taskferry/commit/2ec78a7a6f5cfc0d77fb5f2628a843aa6eb7c7dc))
* **tasks:** don't let a gracefully-exiting SIGTERM'd child mask provider exhaustion ([e831281](https://github.com/jeremysball/taskferry/commit/e83128110f5600422a0c1a301f2aebdc377ef5da))
* **tasks:** error classification, failureDetail, resume hints ([#25](https://github.com/jeremysball/taskferry/issues/25)) ([db4c322](https://github.com/jeremysball/taskferry/commit/db4c3223e3687104e3826b41bbeca4e96b8bb4d4))
* **tasks:** make wait hang until settlement, keep --timeout-ms as an override ([8cd5201](https://github.com/jeremysball/taskferry/commit/8cd5201452526e287e5f101984bd8dc8190d9b4a))
* **tasks:** raise post-output no-output watchdog to 10 minutes ([#27](https://github.com/jeremysball/taskferry/issues/27)) ([88063bd](https://github.com/jeremysball/taskferry/commit/88063bd4a427a263d06df9d5d70c3b18e946ebdc))
* **tasks:** remove silent 45s clamp on wait/poll timeout ([35287ee](https://github.com/jeremysball/taskferry/commit/35287eef32f119915f3db35c285e1a1842b9dccd))
* **tasks:** remove taskferry-summary opencode agent isolation mechanism ([#120](https://github.com/jeremysball/taskferry/issues/120)) ([c23aeb7](https://github.com/jeremysball/taskferry/commit/c23aeb7c55fd428f3dba043deeee54fcaf0932c5))
* **tasks:** scan readSessionIdFromLog incrementally instead of buffering the whole log ([#110](https://github.com/jeremysball/taskferry/issues/110)) ([4913a2b](https://github.com/jeremysball/taskferry/commit/4913a2b18a2765f9bec1abc42cb36ec1389ed0e8))
* **tasks:** show promptTotalChars when promptPreview is truncated ([e359067](https://github.com/jeremysball/taskferry/commit/e35906744a5e5c24c913618e5d89bcc9011a9416))
* **tasks:** stop concatenating every step's narration into opencode_result ([305e486](https://github.com/jeremysball/taskferry/commit/305e486fc5e7ff5ab435f4584e3cc03c08c3b8fe))
* **tasks:** sum tokens/cost across every step_finish, not just the last ([#202](https://github.com/jeremysball/taskferry/issues/202)) ([a647913](https://github.com/jeremysball/taskferry/commit/a64791353f9710953b79659f17db1875e18cce30)), closes [#201](https://github.com/jeremysball/taskferry/issues/201)
* **tasks:** surface provider exhaustion status reliably ([#10](https://github.com/jeremysball/taskferry/issues/10)) ([6afba07](https://github.com/jeremysball/taskferry/commit/6afba07a48f6e903cdec75a57345d6f802a60c17))
* **tasks:** switch default summary model off the unresponsive deepseek-v4-flash ([#29](https://github.com/jeremysball/taskferry/issues/29)) ([2f75358](https://github.com/jeremysball/taskferry/commit/2f75358e37b59962a7bb844c0dc684dc5a239994))
* **tasks:** wait hangs until settlement; escalate no-output watchdog ([#21](https://github.com/jeremysball/taskferry/issues/21)) ([db5309c](https://github.com/jeremysball/taskferry/commit/db5309cab555c478fd0f5563631428267f017744))
* **test:** wire commands.test.js into the test:unit script ([6c837fe](https://github.com/jeremysball/taskferry/commit/6c837feda467913ef4f2ebe4319cfe0e467b0ede))
* **wait:** apply a default timeout instead of blocking forever ([421d0e3](https://github.com/jeremysball/taskferry/commit/421d0e3dfb2a9c9072812f6389a6edb752c21c10))
* **wait:** apply a default timeout instead of blocking forever ([8755968](https://github.com/jeremysball/taskferry/commit/87559683fd189a4ab1223d04afabfda3cd30a1e1))
* **watch:** drop unreachable originSessionId subscription plumbing ([37cf2e0](https://github.com/jeremysball/taskferry/commit/37cf2e0478deee5ea82cea70d4cc97eabbd581c8))
* **watch:** remove claude-monitor and finish issue [#87](https://github.com/jeremysball/taskferry/issues/87) follow-ups ([3f194ed](https://github.com/jeremysball/taskferry/commit/3f194ed2e86f4297dd9552875c6517ee035e1ef5))
* **watch:** remove claude-monitor live-activity notification feature ([7333b64](https://github.com/jeremysball/taskferry/commit/7333b64c801fa48c207115e8efc152b36f0be569))


### Performance Improvements

* **doctor:** run health checks concurrently instead of sequentially ([c076b91](https://github.com/jeremysball/taskferry/commit/c076b91e52e65fc5b8953afdea3a54dd89ff6ee9))
* **doctor:** run health checks concurrently instead of sequentially ([2ee3d17](https://github.com/jeremysball/taskferry/commit/2ee3d1711c9455a0acbe2b52915584813ebc21b6))
