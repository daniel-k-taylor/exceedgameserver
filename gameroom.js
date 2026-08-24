import Player from './player.js'
import { v4 as uuidv4 } from 'uuid';

import { upload_to_blob_storage } from './blobstorage.js';

class GameRoom {
  constructor(version, room_name, database, starting_timer, enforce_timer, minimum_time_per_choice, reconnect_grace_ms = 0) {
    this.database = database
    this.name = room_name
    this.players = []
    this.gameStarted = false
    this.version = version
    this.observers = []
    this.message_log = []
    this.is_game_over = false
    this.match_stat_time = null
    this.firstplayer = 0
    this.reported_match_result = {}
    this.disconnects = 0
    this.starting_timer = starting_timer
    this.enforce_timer = enforce_timer
    this.minimum_time_per_choice = minimum_time_per_choice
    this.reconnect_grace_ms = reconnect_grace_ms
  }

  get_observer_count() {
    return this.observers.length
  }

  get_connected_player_count() {
    return this.players.filter(player => player.connected).length
  }

  get_disconnected_players() {
    return this.players.filter(player => !player.connected)
  }

  has_disconnected_player() {
    return this.get_disconnected_players().length > 0
  }

  is_empty() {
    return this.players.length === 0 && this.observers.length === 0
  }

  // Messages an already-running game needs in order to rebuild its state.
  get_replay_messages() {
    const game_start_message = this.message_log.find(message => message.type === 'game_start')
    if (!game_start_message) {
      return []
    }
    const game_messages = this.message_log.filter(message => message.type === 'game_message')
    return [game_start_message, ...game_messages]
  }

  get_player_name(index) {
    if (index < this.players.length) {
      return this.players[index].name
    }
    return ""
  }

  get_player_deck(index) {
    if (index < this.players.length) {
      return this.players[index].deck_id
    }
    return ""
  }

  get_player_custom_deck_portrait(index) {
    if (index < this.players.length) {
      if (this.players[index].custom_deck_definition) {
        // If this player has a custom deck definition,
        // get their portrait field if it exists.
        // Double check that it is actually a string too.
        if (typeof this.players[index].custom_deck_definition.portrait_image_url === 'string') {
          // If the portrait field is a string, return it.
          // This is a URL to the image.
          return this.players[index].custom_deck_definition.portrait_image_url
        }
      }
      return this.players[index].custom_deck_definition
    }
    return null
  }

  join(player) {
    if (this.players.length < 2 && !this.gameStarted) {
      this.players.push(player)
      player.set_room(this)
      console.log(`Player joined. Total players: ${this.players.length}`)
      if (this.players.length === 2) {
        this.startGame()
      } else {
        const message = {
          type: 'room_waiting_for_opponent',
        }
        player.send(message)
      }
      return true
    }
    return false
  }

  observe(player) {
    player.set_room(this)
    this.observers.push(player)

    const message = {
      type: 'observe_start',
      messages: this.message_log
    }
    player.send(message)
    return true
  }

  is_observer(player) {
    return this.observers.includes(player)
  }

  is_player(player) {
    return this.players.includes(player)
  }

  game_over() {
    if (this.is_game_over) {
      return
    }

    this.is_game_over = true
    if (this.gameStarted) {
      this.submit_match_data()
    }
  }

  close_room() {
    this.is_game_over = true
    // Expect no players, may have observers.
    for (const player of this.players) {
      player.set_room(null)
    }
    for (const player of this.observers) {
      player.set_room(null)
    }
  }

  report_match_result(match_result_message) {
    this.reported_match_result = match_result_message
    this.game_over()
  }

  submit_match_data() {

    // Very first message is the game start message.
    var start_message = this.message_log[0]
    var message_count = this.message_log.length
    var p1name = start_message.player1_name
    var p2name = start_message.player2_name
    var p1deck = start_message.player1_deck_id
    var p2deck = start_message.player2_deck_id
    var match_end_time = new Date()
    // Create a new guid for match id
    var match_id = uuidv4();

    var winning_player_number = 0
    var p1life = 0
    var p2life = 0
    var p1clock = 0
    var p2clock = 0
    if (Object.keys(this.reported_match_result).length > 0) {
      winning_player_number = this.reported_match_result['winning_player']
      p1life = this.reported_match_result['p1life']
      p2life = this.reported_match_result['p2life']
      p1clock = this.reported_match_result['p1clock']
      p2clock = this.reported_match_result['p2clock']
    }

    var match_result_str = "Not Reported"
    if (winning_player_number == 1) {
      match_result_str = "Player 1 Wins"
    } else if (winning_player_number == 2) {
      match_result_str = "Player 2 Wins"
    }

    console.log("Match result (" + match_id + "): " + p1name + " vs " + p2name + " - " + match_result_str)

    const matchData = {
      MatchId: match_id,
      Player1Name: p1name,
      Player2Name: p2name,
      Player1Character: p1deck,
      Player2Character: p2deck,
      StartTime: this.match_stat_time,
      EndTime: match_end_time,
      MatchResult: match_result_str,
      GameVersion: this.version,
      MatchEventLength: message_count,
      MatchLog: JSON.stringify(this.message_log),
      FirstPlayer: this.firstplayer,
      Player1Life: p1life,
      Player2Life: p2life,
      Disconnects: this.disconnects,
      Player1Clock: p1clock,
      Player2Clock: p2clock,
      StartingTimer: this.starting_timer,
      EnforceTimer: this.enforce_timer,
      MinimumTimePerTurn: this.minimum_time_per_choice
    };

    upload_to_blob_storage(matchData);

    if (this.database.isEnabled()) {
      this.database.insertMatchData(matchData);
    }
  }

  startGame() {
    if (this.players.length === 2 && !this.gameStarted) {
      this.gameStarted = true
      this.match_stat_time = new Date()
      console.log('Game started!')
      const starting_player = Math.random() < 0.5 ? 0 : 1
      this.firstplayer = starting_player + 1
      const seed = Math.floor(Math.random() * 9223372036854775807)
      const message = {
        type: 'game_start',
        seed_value: seed,
        starting_player_id: this.players[starting_player].id,
        player1_name: this.players[0].name,
        player1_id: this.players[0].id,
        player1_deck_id: this.players[0].deck_id,
        player1_custom_deck: this.players[0].custom_deck_definition,
        player2_name: this.players[1].name,
        player2_id: this.players[1].id,
        player2_deck_id: this.players[1].deck_id,
        player2_custom_deck: this.players[1].custom_deck_definition,
        starting_timer: this.starting_timer,
        enforce_timer: this.enforce_timer,
        minimum_time_per_choice: this.minimum_time_per_choice
      }
      this.broadcast(message)
    }
  }

  handle_game_message(player, message) {
    if (message['action_type'] == 'match_result') {
      this.report_match_result(message)
    } else {
      // Broadcast this message to both players.
      this.broadcast(message)
    }
  }

  broadcast(message) {
    this.message_log.push(message)
    for (const player of this.players) {
      // Copy per recipient. Mutating the shared object would leak the last
      // player's id into the message log and into every observer's copy.
      player.send({ ...message, your_player_id: player.id })
    }
    for (const player of this.observers) {
      player.send(message)
    }
  }

  // Out of band notifications that are not part of the replayable game log.
  broadcast_to_peers(source_player, message) {
    for (const player of this.players) {
      if (player !== source_player) {
        player.send(message)
      }
    }
    for (const player of this.observers) {
      player.send(message)
    }
  }

  get_reconnect_deadline(player, reconnect_grace_ms) {
    if (player.connected || !player.last_disconnect_at) {
      return null
    }
    return player.last_disconnect_at.getTime() + reconnect_grace_ms
  }

  // An abnormal disconnect during a live game. The seat is held so the player
  // can reclaim it with their session token before the grace period expires.
  hold_seat_for_reconnect(player, reconnect_grace_ms) {
    if (!this.is_player(player) || !this.gameStarted || this.is_game_over) {
      return false
    }

    this.disconnects += 1
    console.log(`Player ${player.name} disconnected from ${this.name}, holding seat for reconnect`)
    this.broadcast_to_peers(player, {
      type: 'player_disconnect_pending',
      id: player.id,
      name: player.name,
      player_id: player.id,
      player_name: player.name,
      reconnect_deadline: this.get_reconnect_deadline(player, reconnect_grace_ms),
    })
    return true
  }

  player_reconnect(player) {
    if (!this.is_player(player) || !this.gameStarted) {
      return false
    }

    console.log(`Player ${player.name} reconnected to ${this.name}`)
    this.broadcast_to_peers(player, {
      type: 'player_reconnect',
      id: player.id,
      name: player.name,
      player_id: player.id,
      player_name: player.name,
    })
    return true
  }

  // The grace period ran out. Fall back to the pre-reconnect behaviour so
  // clients see exactly the disconnect they have always seen.
  expire_held_seat(player) {
    if (!this.is_player(player)) {
      return false
    }

    this.players = this.players.filter(p => p !== player)
    this.broadcast({
      type: 'player_disconnect',
      id: player.id,
      name: player.name,
      player_id: player.id,
      player_name: player.name,
      reason: 'reconnect_timeout',
    })
    this.end_game_if_not_enough_players()
    return true
  }

  // A two player game cannot continue once a seat is permanently vacated, so
  // the room must not keep advertising itself as a live match that somebody
  // could be restored back into.
  end_game_if_not_enough_players() {
    if (this.players.length === 0) {
      this.game_over()
      return
    }
    if (this.gameStarted && this.players.length < 2) {
      this.game_over()
      return
    }
    // Held seats keep a player in this.players, so a room where everybody has
    // disconnected still looks like a live match. Nobody is waiting for a
    // reconnect that nobody is present to complete, and restoring into it
    // strands the returning player in an inescapable "waiting for opponent"
    // overlay for a match that no longer exists.
    if (this.gameStarted && this.get_connected_player_count() === 0) {
      console.log(`Room ${this.name} has no connected players left, ending the game`)
      this.game_over()
    }
  }

  // Returns true when the caller should clear the player's room reference.
  // A held seat returns false so the player can be restored into this game.
  player_quit(player, disconnect) {
    if (this.is_observer(player)) {
      this.observers = this.observers.filter(p => p !== player)
      return true
    } else if (this.is_player(player)) {
      if (disconnect && this.gameStarted && !this.is_game_over) {
        const seat_held = this.hold_seat_for_reconnect(player, this.reconnect_grace_ms)
        if (seat_held) {
          // That may have been the last player present.
          this.end_game_if_not_enough_players()
        }
        return !seat_held
      }
      if (disconnect) {
        this.disconnects += 1
      }
      this.players = this.players.filter(p => p !== player)
      const message = {
        type: disconnect ? 'player_disconnect' : 'player_quit',
        id: player.id,
        name: player.name,
        player_id: player.id,
        player_name: player.name,
      }
      this.broadcast(message)
      this.end_game_if_not_enough_players()
      return true
    }

    return false
  }
}

export default GameRoom
