import json, sys
config = json.loads(sys.stdin.read() or "{}")
print(json.dumps({"type": "log", "message": "starting"}), flush=True)
print("a bare print left in during debugging", flush=True)
print(json.dumps({"bare": "object with no type"}), flush=True)
for i in range(int(config.get("n", 3))):
    print(json.dumps({"type": "item", "data": {"i": i, "echo": config.get("echo")}}), flush=True)
sys.stdout.write(json.dumps({"type": "item", "data": {"trailing": "no newline"}}))
