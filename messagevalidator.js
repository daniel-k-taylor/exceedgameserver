// Sets formatting requirements for json messages from clients.
// Import and call validate_message to check whether a message
// meets the requirements.

// Items in a json are always strings and may need to be coerced
// to other types to check validity. To check if an item is a string,
// supply "string" as a value. If the item ought to be anything else,
// supply a function which checks whether the appropriate coercion
// is valid.

message_formats = {
    "set_name" : {
        "player_name": "string",
        "version" : "string"
    },
    "join_queue" : {
        "deck_id" : "string",
        "version" : "string",
        "starting_timer" : isFinite,
        "minimum_time_per_choice" : isFinite,
        "enforce_timer" : check_if_string_is_bool,
        "queue_type" : "string",
        "desired_queue_id" : isFinite,
        "queue_display_name" : "string"
    },
    "observe_room" : {
        "room_id" : "string",
        "version" : "string"
    }
}

function validate_message(message, message_type) {
    if (typeof message != "object") {
        return false
    }
    message_definition = message_formats[message_type]
    for (message_field in message_definition) {
        if (!(message_field in message)) {
            console.log("Error: Message of type %s does not contain field %s.", message_type, message_field)
            return false
        }
        if (message_definition[message_field] == "string") {
            if (typeof message[message_field] != string) {
                console.log("Error: Message of type %s has a field %s which should be a string, but is not.", message_type, message_field)
                return false
            }
        } else { 
            // The message_definiton's field doesn't contain string. Instead it contains a function
            // which tests the type of what's in the message
            testing_function = message_definition[message_field]
            if (!testing_function(message[message_field])) {
                console.log("Error: Message of type %s has a field %s which failed test %s.", message_type, message_field, testing_function)
                return false
            }
        }
    }
    return true
}

function check_if_string_is_bool(str) {
    return (str == "true" || str == "false")
}

export default validate_message