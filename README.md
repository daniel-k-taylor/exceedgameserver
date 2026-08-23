# Exceed fan game server
A simple node JS game web server app for the exceed fan game client.
Run locally with: node server.js

Run the tests with: npm test

## Sessions and reconnecting

A websocket connection and a player session are separate things. Every player
gets a session that outlives its websocket, so a client that drops out of a
game can come back and reclaim its seat.

There are no accounts, so the server cannot recognise a returning client on its
own. Instead the client holds a credential and presents it on reconnect.

### Handshake

`server_hello` (and `name_update`) carry the identifiers the client must keep:

| Field | Meaning |
| --- | --- |
| `player_id` | Public uuid used throughout the game protocol |
| `session_id` | Public session handle, safe to log |
| `session_token` | **Secret.** The only credential accepted for a restore |

The client should persist all three (localStorage on web, `user://` natively).

### Restoring

On reconnect the client sends:

```json
{
  "type": "restore_session",
  "context": {
    "previous_session_token": "<saved session_token>",
    "previous_session_id": "<saved session_id>",
    "previous_player_id": "<saved player_id>"
  }
}
```

The token is the only match key. `previous_session_id` and `previous_player_id`
are optional consistency checks: if they are supplied and disagree with the
session the token resolves to, the restore is refused. Names, room ids and IP
addresses are never used to match a session.

On success the server rebinds the websocket onto the original player object and
replies with `session_restored`, which contains the restored identity plus
`room_id`, `in_game`, `queue_id`, `lobby_state`, `opponent_name`,
`opponent_connected` and `messages`. `messages` is the `game_start` message
followed by every `game_message`, which is everything the client needs to
rebuild an in progress game and resume automatically.

On failure the server replies with `session_restore_failed` and a `reason` of
`missing_session_token`, `no_matching_session`, `session_mismatch` or
`current_player_missing`. The client should then carry on as a new player.

### Disconnects during a game

| Event | Message | Sent to |
| --- | --- | --- |
| A player's connection drops | `player_disconnect_pending` (with `reconnect_deadline`) | The opponent and observers |
| They restore in time | `player_reconnect` | The opponent and observers |
| The grace period expires | `player_disconnect` | The room |

The seat is held for `RECONNECT_GRACE_MS`. Nobody else can join it during that
window; only the holder of the session token can reclaim it. Once the grace
period expires the player is removed and clients see the same `player_disconnect`
they always have. A deliberate `leave_room` is immediate and never holds a seat.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `RECONNECT_GRACE_MS` | 120000 | How long a seat in a live game is held |
| `SESSION_GRACE_MS` | 600000 | How long a session stays restorable (never less than the reconnect grace) |
| `KEEPALIVE_INTERVAL_MS` | 15000 | Websocket ping interval, also drives `server_keepalive` |

### Other client facing messages

- `server_keepalive` is pushed on the keepalive interval so browser clients,
  which cannot see websocket level pings, can tell the server is still alive.
- `request_players_update` asks for a `players_update` on demand instead of
  waiting for the next broadcast.
- `players_update` rooms now also report `connected_player_count`, `game_over`
  and `player_connected`, and queues report `waiting_deck_id` for the character
  currently sitting in the queue.
