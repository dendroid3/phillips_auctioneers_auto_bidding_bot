#!/bin/bash

# ---- Configurable URLs ----
BASE_URL="https://phillipsauctioneers.co.ke"
ACCOUNT_URL="$BASE_URL/my-account/"
LOGIN_URL="$BASE_URL/wp-admin/admin-ajax.php"
BID_URL="$BASE_URL/wp-admin/admin-ajax.php"

# ---- Functions ----

# Print usage help
print_usage() {
    echo "Usage: $0 <username> <password> <phillips_vehicle_id> <amount> <increment> <maximum_amount> <trigger_time>"
    exit 1
}

# Fetch HTML from the login page
fetch_login_page() {
    echo "[*] Fetching login page..."
    xh GET "$ACCOUNT_URL"
}

# Extract the nonce from the HTML
extract_nonce() {
    local html="$1"
    echo "$html" | grep -oP '"ur_login_form_save_nonce"\s*:\s*"\K[^"]+'
}

# Perform login and save cookies
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
    
    echo "Placing bid of $amount on $phillips_vehicle_id"
    
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
    --headers --all 2>&1 | tee "$username-login_response.txt")
    
    if [ -z "$response" ]; then
        echo "[!] No response received from xh" >&2
    fi
    
    grep -i "^Set-Cookie:" "$username-login_response.txt" > "$username-cookies.txt"
}

# ---- Main Script ----

main() {
    # Check args
    if [ "$#" -ne 7 ]; then
        print_usage
    fi
    
    local username="$1"
    local password="$2"
    local phillips_vehicle_id="$3"
    local amount="$4"
    local increment="$5"
    local maximum_amount="$6"
    local trigger_time="$7"
    
    # Step 1: Fetch login page HTML
    local html
    html=$(fetch_login_page)
    
    # Step 2: Extract nonce
    local nonce
    nonce=$(extract_nonce "$html")
    
    if [ -z "$nonce" ]; then
        echo "[✗] Nonce not found."
        exit 1
    fi
    
    echo "[✓] Nonce found: $nonce"
    
    # Step 3: Login and save cookies
    perform_login "$username" "$password" "$nonce"
    
    local vehicles
    vehicles=$(xh -q POST ":/api/sniping/init" \
        auction_session_id=1 \
    phillips_account_id=2 | jq -r '.[]')
    
    echo "$vehicles"
    for vehicle in $vehicles; do
        echo "Doing for $vehicle"
        bid_response=$(place_bid "$phillips_vehicle_id" "$amount")
        
        
        # Recussion occours here, loop with increment until highest, then add 1 if highest in 2 seconds heatbeats, final 3 seconds, place amount + increment *3
        echo "$bid_response"
    done
    # while !$time_elapsed do
    #     # For each car
    #     $amount_to_place=$amount+($increment * $trials)
    #     bid_response=$(place_bid "$phillips_vehicle_id" "$amount_to_place")
    
}

# Execute main with command-line arguments
main "$@"
