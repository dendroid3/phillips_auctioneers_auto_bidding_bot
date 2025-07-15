#!/bin/bash

# ---- Configurable URLs ----
BASE_URL="https://phillipsauctioneers.co.ke"
ACCOUNT_URL="$BASE_URL/my-account/"
LOGIN_URL="$BASE_URL/wp-admin/admin-ajax.php"
BID_URL="https://kodembe.top/api/bid"

# ---- Helper Functions ----

print_usage() {
    echo "Usage: $0 <username> <password> <bid_stage_id> <phillips_account_id> <auction_session_id> <start_time> <end_time>"
    exit 1
}

fetch_login_page() {
    echo "[*] Fetching login page..."
    xh GET "$ACCOUNT_URL"
}

extract_nonce() {
    local html="$1"
    echo "$html" | grep -oP '"ur_login_form_save_nonce"\s*:\s*"\K[^"]+'
}

perform_login() {
    local username="$1"
    local password="$2"
    local nonce="$3"

    echo "[*] Logging in with username: $username"

    xh -f POST "$LOGIN_URL" \
        action=user_registration_ajax_login_submit \
        security="$nonce" \
        username="$username" \
        password="$password" \
        --headers > "$username-login_response.txt"

    grep -i "^Set-Cookie:" "$username-login_response.txt" > "$username-cookies.txt"
    echo "[✓] Cookies saved to $username-cookies.txt"
}

place_bid() {
    local phillips_vehicle_id="$1"
    local amount="$2"

    local cookie_header
    cookie_header=$(awk -F': ' '/set-cookie:/ {
        split($2, parts, ";");
        split(parts[1], nv, "=");
        printf "%s=%s; ", nv[1], nv[2]
    }' "$username-cookies.txt" | sed 's/; $//')

    local response
    response=$(xh -v -f POST "$BID_URL" \
        action=yith_wcact_add_bid \
        security="$nonce" \
        currency=KES \
        bid="$amount" \
        product="$phillips_vehicle_id" \
        "Cookie: $cookie_header" \
        --headers --all 2>&1)

    # Extract response body
    local body
    body=$(echo "$response" | grep -Eo '\{.*\}' | tail -n1)

    # Extract .success from JSON
    success=$(echo "$body" | jq -r '.success')

    if [ "$success" = "true" ]; then
        echo "Highest"
    elif [ "$success" = "false" ]; then
        echo "Outbidded"
    else
        echo "$success"
    fi
}

# ---- Main Logic ----

main() {
    if [ "$#" -ne 7 ]; then
        print_usage
    fi

    local username="$1"
    local password="$2"
    local bid_stage_id="$3"
    local phillips_account_id="$4"
    local auction_session_id="$5"
    local start_time="$6"
    local end_time="$7"

    # Fetch and extract nonce
    local html
    html=$(fetch_login_page)
    nonce=$(extract_nonce "$html")

    if [ -z "$nonce" ]; then
        echo "[✗] Nonce not found."
        exit 1
    fi

    echo "[✓] Nonce found: $nonce"

    perform_login "$username" "$password" "$nonce"

    # Fetch vehicle data
    vehicles=($(xh POST ":/api/sniping/init" \
        auction_session_id=$auction_session_id \
        phillips_account_id=$phillips_account_id \
        --body | jq -c '.[]'))

    # Track bid state per vehicle
    declare -A current_bids
    declare -A increments
    declare -A max_amounts

    while true; do
        current_time=$(date +%H:%M:%S)

        if [[ "$current_time" > "$start_time" && "$current_time" < "$end_time" ]]; then
            echo "⏱️ $current_time is between $start_time and $end_time"

            for vehicle_json in "${vehicles[@]}"; do
                phillips_vehicle_id=$(jq -r '.phillips_vehicle_id' <<< "$vehicle_json")
                vehicle_id=$(jq -r '.id' <<< "$vehicle_json")
                sniping_increment=$(jq -r '.sniping_stage_increment' <<< "$vehicle_json")
                maximum_amount=$(jq -r '.maximum_amount' <<< "$vehicle_json")
                initial_bid=$(jq -r '.current_bid' <<< "$vehicle_json")

                # Initialize tracking
                if [ -z "${current_bids[$vehicle_id]}" ]; then
                    current_bids[$vehicle_id]=$initial_bid
                    increments[$vehicle_id]=$sniping_increment
                    max_amounts[$vehicle_id]=$maximum_amount
                fi

                amount=${current_bids[$vehicle_id]}
                bid_response=$(place_bid "$phillips_vehicle_id" "$amount")
                bid_response_cleaned=$(echo "$bid_response" | tr -d '\r\n' | sed 's/^[ \t]*//;s/[ \t]*$//')

                # Send to your API
                bid=$(
                    xh POST ":/api/bid/create" \
                        amount="$amount" \
                        vehicle_id="$vehicle_id" \
                        phillips_account_email="$username" \
                        bid_stage_id="$bid_stage_id" \
                        status="$bid_response_cleaned" \
                        2>&1
                )

                # Determine next bid
                if [ "$bid_response_cleaned" = "Highest" ]; then
                    next_bid=$(( amount + 100 ))
                elif [ "$bid_response_cleaned" = "Outbidded" ]; then
                    next_bid=$(( amount + ${increments[$vehicle_id]} ))
                else
                    echo "[✗] Unknown bid response: '$bid_response_cleaned'"
                    continue
                fi

                # # Cap at max
                if [ "$next_bid" -gt "${max_amounts[$vehicle_id]}" ]; then
                    current_bids[$vehicle_id]=${max_amounts[$vehicle_id]}
                else
                    current_bids[$vehicle_id]=$next_bid
                fi

            done

        elif [[ "$current_time" > "$start_time" && "$current_time" > "$end_time" ]]; then
            echo "⛔ $current_time is outside the target window ($start_time - $end_time). Exiting."
            break
        fi

        # sleep 1
    done
}

# Run it
main "$@"
