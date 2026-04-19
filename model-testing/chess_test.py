import os
import requests
import json
import time
import re
import sys

# Models to explicitly exclude even if they report 0 pricing
EXCLUDE_MODELS = [
    "google/lyria-3-pro-preview",
    "google/lyria-3-clip-preview"
]

def get_api_key():
    api_key = os.getenv("AI_API_KEY")
    if api_key:
        return api_key
    try:
        with open("../.env", "r") as f:
            for line in f:
                if line.startswith("AI_API_KEY="):
                    return line.split("=", 1)[1].strip()
    except FileNotFoundError:
        pass
    return None

def sanitize_filename(filename):
    return re.sub(r'[\\/*?:"<>|]', "_", filename)

def should_skip(filename):
    if not os.path.exists(filename):
        return False
    if os.path.getsize(filename) < 1000: # Very small files are likely incomplete or errors
        return False
    try:
        with open(filename, "r", encoding="utf-8") as f:
            content = f.read()
            if "Error querying" in content or "429" in content or "Error: Unexpected" in content:
                return False
            # Check if all 3 variants are present
            if "VARIANT 1:" in content and "VARIANT 2:" in content and "VARIANT 3:" in content:
                return True
    except:
        return False
    return False

def retry_post(url, headers, data, timeout=120, max_retries=6):
    for attempt in range(max_retries):
        try:
            resp = requests.post(url, headers=headers, data=data, timeout=timeout)
            if resp.status_code == 200:
                # Even with 200, check if the response body contains an error (sometimes OpenRouter does this)
                try:
                    res_json = resp.json()
                    if "error" in res_json:
                        # If it's a rate limit error inside a 200, retry
                        if res_json["error"].get("code") in [429, 427]:
                            wait_time = (2 ** attempt) * 15
                            print(f"Retrying in {wait_time}s due to internal error {res_json['error'].get('code')} (attempt {attempt+1}/{max_retries})", flush=True)
                            time.sleep(wait_time)
                            continue
                except:
                    pass
                return resp
            
            # Exponential backoff for rate limiting and server errors
            if resp.status_code in [408, 427, 429, 500, 502, 503, 504]:
                wait_time = (2 ** attempt) * 15
                print(f"Retrying in {wait_time}s due to status {resp.status_code} (attempt {attempt+1}/{max_retries})", flush=True)
                time.sleep(wait_time)
                continue
            
            # Other errors should probably just return so they can be logged
            return resp
        except (requests.exceptions.RequestException, Exception) as e:
            wait_time = (2 ** attempt) * 15
            print(f"Retrying in {wait_time}s due to exception: {e} (attempt {attempt+1}/{max_retries})", flush=True)
            time.sleep(wait_time)
    return None

def main():
    print("Starting script main...", flush=True)
    api_key = get_api_key()
    if not api_key:
        print("AI_API_KEY not found in env or ../.env", flush=True)
        return

    print("Fetching models from OpenRouter...", flush=True)
    try:
        response = requests.get("https://openrouter.ai/api/v1/models")
        response.raise_for_status()
        models = response.json().get("data", [])
    except Exception as e:
        print(f"Failed to fetch models: {e}", flush=True)
        return

    free_models = []
    for m in models:
        m_id = m["id"]
        if m_id in EXCLUDE_MODELS:
            continue
            
        pricing = m.get("pricing", {})
        try:
            prompt_price = float(pricing.get("prompt", 1))
            completion_price = float(pricing.get("completion", 1))
            if prompt_price == 0 and completion_price == 0:
                free_models.append(m_id)
        except (ValueError, TypeError):
            continue

    if not free_models:
        print("No free models found.", flush=True)
        return

    print(f"Found {len(free_models)} free models.", flush=True)

    prompts = [
        "Show me your chess knowledge: show 3 board positions and moves where the move choice is trivial.",
        "Can you provide 3 examples of chess positions where there is only one logical or winning move? Explain why.",
        "Describe 3 simple chess tactical or positional scenarios where the best move is absolutely obvious even to a beginner."
    ]

    os.makedirs("results", exist_ok=True)

    for model_id in free_models:
        filename = f"results/{sanitize_filename(model_id)}.txt"
        
        if should_skip(filename):
            print(f"Skipping already processed model: {model_id}", flush=True)
            continue
            
        print(f"Querying model: {model_id} -> {filename}", flush=True)
        
        # Open in write mode to overwrite failed results
        with open(filename, "w", encoding="utf-8") as f:
            f.write(f"Model: {model_id}\n")
            f.write("="*80 + "\n\n")

            for i, prompt in enumerate(prompts, 1):
                f.write(f"VARIANT {i}: {prompt}\n")
                f.write("-" * 40 + "\n")
                
                resp = retry_post(
                    "https://openrouter.ai/api/v1/chat/completions",
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                        "HTTP-Referer": "https://github.com/google/gemini-cli",
                        "X-Title": "Gemini-CLI-Assistant"
                    },
                    data=json.dumps({
                        "model": model_id,
                        "messages": [{"role": "user", "content": prompt}]
                    }),
                    timeout=150
                )
                
                if resp is not None and resp.status_code == 200:
                    try:
                        data = resp.json()
                        if "choices" in data and len(data["choices"]) > 0:
                            content = data["choices"][0]["message"]["content"]
                            f.write(content + "\n\n")
                        elif "error" in data:
                            f.write(f"Error in response from {model_id}:\n")
                            f.write(json.dumps(data, indent=2) + "\n\n")
                        else:
                            f.write(f"Error: Unexpected response format from {model_id}\n")
                            f.write(json.dumps(data, indent=2) + "\n\n")
                    except Exception as json_err:
                        f.write(f"Error parsing JSON from {model_id}: {json_err}\n\n")
                elif resp is not None:
                    f.write(f"Error querying {model_id}: {resp.status_code}\n")
                    f.write(resp.text + "\n\n")
                else:
                    f.write(f"Error: Failed to get response after retries for {model_id}\n\n")
                
                # Moderate delay between variants
                time.sleep(5)
            
            f.write("="*80 + "\n")
        
        # Moderate delay between models
        time.sleep(10)

if __name__ == "__main__":
    main()
