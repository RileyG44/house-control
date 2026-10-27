# The house agent and the voice button

Say (or type) what you want — "dim the kitchen to 30 and put on The Goonies", "warm the bedroom
to 70", "pause the music on the Echo" — and the hub's Codex agent does it with the same tools a
person has in the panel. The Codex that writes the TV's nightly picks (smart_recs.py) is the one
that runs the house: same install, same sign-in, on the home server (dell-server).

```
iPhone / panel ──"turn off the lights"──▶ POST /api/agent ──▶ codex exec ──MCP (stdio)──▶ agent_mcp.py
     ▲                                          │                                           │
     └──── SSE {"agent": …} steps + reply ◀─────┘           loopback POST /api/agent/tool/<name>
                                                                                            ▼
                                                                        Hub.command / tv / spotify
```

## Pieces

### hub/agent.py — the tools and the runner

`HouseTools(hub)` runs inside the hub process and calls the hub's own code (no HTTP round trip):

| Tool | Arguments | Does |
| --- | --- | --- |
| `get_home` | — | Every room with its lights (on, brightness %, white K or colour, abilities, online), ACs (on, mode, target, fan, room temperature, unit, range, modes, fans), the TV (on, app, what plays, volume), the speaker (Spotify: track, playing, device, volume, outputs) and the scenes. Text for the model plus a JSON copy. |
| `set_lights` | `lights`: ids, names, room ids/names or `"all"`; `on`, `brightness` (1–100), `kelvin`, `color` (name or `#rrggbb`) | Hub.command for each light, its patch in panel units (brightness 0–1, temp K, color hex). |
| `set_climate` | `ac` (id/name/room, default the only one), `on`, `mode` (cool/heat/dry/fan/auto), `target` (the AC's unit), `fan` | Hub.command for the AC; a target, mode or fan switches it on. Range, modes and fans are the AC's own (Cielo's). |
| `activate_scene` | `scene` (id or name) | The scene the way the panel's store.applyScene does it: lights `*` + per id (temp clears colour), ACs, TV apps, Spotify uri. |
| `tv` | `action`: a remote key (KEYS), `volume` + `level`, `open` + `app`, `search` + `text`, `power`/`wake`/`sleep` | TvRemote.act on the one TV. |
| `find_title` | `query` | TvRemote.search (JustWatch): titles with the apps the TV has and their links. |
| `play_title` | `app`, `link` (from find_title) | TvRemote.act `play` (direct-play link; Netflix skips its profile screen). |
| `speaker` | `action`: play, pause, next, previous, volume (+`level`), transfer (+`device` name), play_playlist (+`name`) | Spotify.act; play_playlist looks the name up in the account's playlists. The Echo is a Spotify Connect output. |
| `picks` | — | Tonight's and today's picks (smart-evening.json, smart-recs.json) so "put on something good" has a list to choose from. |

Every tool answers short text: what it did and the new state, or why it couldn't ("Window Light
is offline"), and a one-line `summary` that is the step a screen shows ("Kitchen lights → 30%").
Names match loosely (case, "the", plurals, room + kind: "bedroom light", a name a little misheard:
"counter lite"); two that fit equally are asked about, not guessed. A lamp or AC the plan doesn't
link to a real device is the panels' pretend one: the change is sent to them as a device report.
`TOOLS` in agent.py holds the JSON schemas, the one list both `GET /api/agent/tools` and the MCP
server hand out.

`Agent(hub)` runs requests:

- `POST /api/agent {"text", "client"}` → waits for the run and answers `{"ok", "id", "reply", "steps"}`
  (`steps`: `{"tool", "text", "ok"}`; at most `AGENT_TIMEOUT`, 120 s, then Codex is killed and the
  answer is a failure, HTTP 502 with `error`). Live progress goes to every panel over `/api/events` as
  `{"agent": {"id", "client", "text", "state": "thinking"|"acting"|"done"|"failed", "steps": [...], "reply"}}`;
  a screen shows only the runs with its own `client`.
- One run at a time; a new request while one runs waits for it (they are quick) — at most 3 waiting,
  a fourth is refused (429).
- Codex (found like smart_recs.py finds it: the `PATH`, `~/.local/bin`, an nvm Node's `bin`):
  `codex exec --json --skip-git-repo-check --ephemeral --sandbox read-only --color never --cd <empty tmp>
  --output-last-message <tmp file> -c 'mcp_servers.house.command="<python>"'
  -c 'mcp_servers.house.args=["<…/agent_mcp.py>"]' -c 'mcp_servers.house.env={HOUSE_HUB_URL="http://127.0.0.1:<port>"}'
  -c 'mcp_servers.house.default_tools_approval_mode="approve"' -c 'approval_policy="never"'
  -c 'model_reasoning_effort="low"' -` (the prompt on stdin), plus `-m $HOUSE_AGENT_MODEL` when set;
  `HOUSE_AGENT_EFFORT` replaces `low`. The two approval settings are `CODEX_SETTINGS` in agent.py, so
  they can be changed in one place: they keep a tool call from waiting for an approval no one can
  give, and were written for codex-cli 0.163.0 without being tried on it.
- Steps: the JSONL events' MCP tool calls (`item.started` / `item.completed` with an
  `mcp_tool_call` item, or the older `{"msg": {"type": "mcp_tool_call_begin"}}`), matched with the
  calls the hub itself runs meanwhile (`/api/agent/tool/…`), whose summaries name them; so the steps
  are there even if Codex's event shapes change. The reply is the last agent message, else the
  `--output-last-message` file. Read-only sandbox: Codex can't touch files or the network itself,
  only the house tools.
- The prompt: who Riley is (taste.md when present), the state of the home (get_home's text), the
  time, and the rules: do it, don't ask back unless the request is truly ambiguous, never
  invent devices, answer in one or two short spoken sentences.
- A hub without Codex passes the request to its peer (peer.json, as `{"text", "client", "fromPeer": true}`,
  which the peer never passes back) and relays the answer, so the Mac backup works too while the Dell
  is up; its own panels hear the run start and its result.
- Each run is one line in the hub's log: the request, how it ended, how long, the steps, the reply.

### hub/agent_mcp.py — the MCP server Codex starts

Dependency-free stdio MCP (standard library only; JSON-RPC 2.0 lines; `initialize`, which answers
the client's own protocol version or 2025-06-18, `tools/list`, `tools/call`, `ping`; notifications are
read and not answered). It reads the tool list from `GET /api/agent/tools` (every tool marked
`destructiveHint: false`, `openWorldHint: false`) and runs each call as `POST /api/agent/tool/<name>`;
a hub that doesn't answer is an `isError` result, not a dead server. Those two routes answer only
loopback callers, and not Tailscale Serve's forwarding (which comes from loopback too, with
`X-Forwarded-*` headers). Any other MCP client on the hub computer (Claude Code, Cursor) can use it too:
`claude mcp add house -- ~/house-control/hub/.venv/bin/python ~/house-control/hub/agent_mcp.py`.

### The voice button

- **Web panel** (web/src/ui/voice.js; the hub-served page, the Windows app, and the Mac app, whose
  `hubRequest` now lets `api/agent` through; not the demo): a mic button in the panel header. Press:
  listens with the Web Speech API where the browser has it (Safari, Chrome), shows the words as they
  come, sends on the final result (the pause); where there is none, or it isn't allowed (WKWebView,
  Electron), the card's text field takes it instead, and typing always works (Enter sends). The
  card under the header shows the request, each step ("Kitchen lights → 30%"), then the reply, which
  is spoken (speechSynthesis) when the request was spoken. Esc or × closes. The Mac app gets no
  events from the hub, so there the steps come with the reply.
- **iPhone (ios-native)**: a glass mic button in the top corner over the 3D home (AskButton,
  HomeScreen.swift), or `housenative://ask`. Tap: a sheet over the card (VoiceSheet.swift) that
  listens at once — SFSpeechRecognizer (on-device when supported) fed by AVAudioEngine
  (VoiceAgent.swift), live transcript, sent after 1.5 s of quiet or a tap on the mic — then the
  steps from the hub's SSE `agent` events (HubClient.onAgent, this phone's `clientID` only) and the
  reply, which AVSpeechSynthesizer reads out (the audio session ducks music and gives it back
  after). Its text field takes a typed request. Info.plist (written by xcodegen from project.yml):
  NSMicrophoneUsageDescription, NSSpeechRecognitionUsageDescription.

## Not in this pass

- Alexa itself (announcements, Alexa routines, the Echo's own volume outside Spotify) needs
  Amazon's unofficial cookie API; the Echo is driven through Spotify Connect only.
- A wake word ("hey house").
