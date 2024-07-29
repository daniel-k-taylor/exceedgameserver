import Player from './player.js'
import GameRoom from './gameroom.js';
import validate_message from './messagevalidator.js';
import { WebSocketServer } from 'ws'
import { v4 as uuidv4 } from 'uuid';
import { upload_to_blob_storage } from './blobstorage.js';

class RoomManager {
    constructor(database) {
        this.database = database
        this.running_match_id = 1
        this.game_rooms = {}
    }

    create_room(player1, player2, version, game_type, starting_timer, enforce_timer, minimum_time_per_choice) {
        const room_name = game_type + "_" + this.get_next_match_id()

        var success = false

        const new_room = new GameRoom(
            version,
            room_name,
            this.database,
            starting_timer,
            enforce_timer,
            minimum_time_per_choice
        )

        if (!new_room.join(player1)) {
            const message = {
                type: 'room_join_failed', // Don't know if this still captures info usefully
                reason: 'room_full' // ???
            }
            player1.ws.send(JSON.stringify(message))
        }

        if (!new_room.join(player2)) {
            const message = {
                type: 'room_join_failed', // Don't know if this still captures info usefully
                reason: 'room_full'
            }
            player2.ws.send(JSON.stringify(message))
        }

        this.game_rooms[room_name] = new_room

        broadcast_players_update()

        return true
    }

    observe_room(ws, json_data) {
        
        if (!(validate_message(json_data, "observe_room"))) {
            return false
        }

        var player_join_version = json_data.version

        var player = active_connections.get(ws)
        if (player === undefined) {
            console.log("observe_room Player is undefined")
            return false
        }
        player.version = player_join_version

        var room_name = json_data.room_name.trim()
        if (room_name == "Lobby") {
            const message = {
                type: 'room_join_failed',
                reason: "cannot_join_lobby"
            }
            ws.send(JSON.stringify(message))
            return true
        }

        // Find the match.
        var room = null
        if (this.game_rooms.hasOwnProperty(room_name)) {
            room = this.game_rooms[room_name]
        }

        if (room != null) {
            if (room.version != player_join_version) {
                // Player/Room version mismatch.
                this._join_version_error(ws)
                return true
            }
            var success = room.observe(player)
            if (!success) {
                const message = {
                    type: 'room_join_failed',
                    reason: 'unknown_join_error'
            }
            ws.send(JSON.stringify(message))
            } else {
                // Success!
                broadcast_players_update()
            }
            return true
        } else {
            const message = {
                type: 'room_join_failed',
                reason: 'room_not_found'
            }
            ws.send(JSON.stringify(message))
            return true
        }
    }

    _join_version_error(ws) {
        const message = {
            type: 'room_join_failed',
            reason: 'version_mismatch'
        }
        ws.send(JSON.stringify(message))
    }

    get_next_match_id() {
        var value = this.running_match_id++
        if (this.running_match_id > 999) {
            this.running_match_id = 1
        }
        return value
    }

    leave_room(player, disconnect) {
        if (player.room !== null) {
            var room_id = player.room.name
            if (awaiting_match_room == room_id) {
                awaiting_match_room = null
            }
            player.room.player_quit(player, disconnect)
            if (player.room.is_game_over) {
                console.log("Closing room " + room_id)
                this.game_rooms[room_id].close_room()
                delete this.game_rooms[room_id]
            }
            player.room = null
            broadcast_players_update()
        }
    }
}

export default RoomManager