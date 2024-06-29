// Sets formatting requirements for json messages from clients.
// Import and call validate_message to check whether a message
// meets the requirements.

// Items in the json are always strings and may need to be coerced
// to other types to check validity. To check if an item is a string,
// supply "string" as a value. If the item ought to be anything else,
// supply a function which checks whether the appropriate coercion
// is valid.

message_formats = {
    "set_name" : {
            "player_name": "string",
            "version" : "string"},
        "join_room" : {
            "room_id" : "string",
            "deck_id" : "string",
            "version" : "string",
            "starting_timer" : isFinite,
            "minimum_time_per_choice" : isFinite,
            "enforce_timer" : this.check_if_string_is_bool
        },
        "join_matchmaking" : {
            "deck_id" : "string",
            "version" : "string",
            "match_type" : "string"
        },
        "observe_room" : {
            "room_id" : "string",
            "version" : "string"
        }
}

validate_message(message, message_type) {
    if (typeof message != "object") {
        return false
    }
    compare_to = this.message_formats[message_type]
    for (message_field in compare_to.keys()) {
        if (!(message_field in message[message_field])) {
            console.log("Error: Message of type %s does not contain field %s.", message_type, message_field)
            return false
        }
        if (typeof compare_to[message_field] == string && typeof message[message_field] != "string") {
            console.log("Error: Message of type %s has a field %s which is not a string.", message_type, message_field)
            return false
        }
        if (!(compare_to[message_field](message[message_field]))) {
            console.log("Error: Message of type %s has a field %s which failed test %s.", message_type, message_field, compare_to[message_field])
            return false
        }
    }
    return true
}

check_if_string_is_bool(str) {
    return (str == "true" || str == "false")
}

export default validate_message