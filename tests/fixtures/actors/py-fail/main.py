import json, sys
print(json.dumps({"type": "item", "data": {"before": "the failure"}}), flush=True)
sys.stderr.write("something went wrong\n")
sys.exit(4)
