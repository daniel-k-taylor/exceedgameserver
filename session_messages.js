// Builders for the session restore protocol, kept separate so they can be
// unit tested without standing up a websocket server.

export function build_server_hello_message(player) {
  return {
    type: 'server_hello',
    player_name: player.name,
    ...player.get_identity(),
  }
}

export function build_session_restore_failed_message(reason, details = {}) {
  return {
    type: 'session_restore_failed',
    reason,
    ...details,
  }
}

// Everything the client needs to put itself back where it was.
export function build_player_state_snapshot(player, get_public_room_name) {
  const room = player.room
  const is_room_player = !!(room && room.is_player(player))
  const in_game = !!(room && room.gameStarted && is_room_player)
  const opponent = in_game
    ? room.players.find(room_player => room_player !== player) ?? null
    : null

  return {
    player_id: player.id,
    player_name: player.name,
    session_id: player.session_id,
    session_token: player.session_token,
    room_id: room ? get_public_room_name(room) : null,
    room_version: room ? room.version : null,
    queue_id: player.queue_id,
    lobby_state: player.lobby_state,
    observing: !!(room && room.is_observer(player)),
    in_game,
    game_over: in_game ? room.is_game_over : false,
    opponent_name: opponent ? opponent.name : null,
    opponent_connected: opponent ? opponent.connected : null,
    messages: in_game ? room.get_replay_messages() : [],
  }
}

export function build_session_restored_message(restored_player, temporary_player, snapshot) {
  return {
    type: 'session_restored',
    restored_player_id: restored_player.id,
    removed_temporary_player_id: temporary_player ? temporary_player.id : null,
    ...snapshot,
  }
}

export function build_server_keepalive_message(now = Date.now()) {
  return {
    type: 'server_keepalive',
    server_time: now,
  }
}
