# Testing the Printing Debug Endpoints

This document provides practical examples of using the new debug endpoints.

## Quick Start

Set your admin token:
```bash
export ADMIN_TOKEN="your-admin-token-here"
```

## Example 1: Check Print System Status

Check if the print system is working and view the current queue:

```bash
curl -H "X-Admin-Token: $ADMIN_TOKEN" http://localhost:8080/api/debug/print-status | jq .
```

### Expected Response:
```json
{
  "ok": true,
  "queue": {
    "count": 0,
    "jobs": []
  },
  "done": {
    "count": 10,
    "recentJobs": [...]
  },
  "lastCallback": {
    "when": "2025-10-19T18:46:16.186Z",
    ...
  },
  "printerToken": "***set***",
  "timestamp": "2025-10-19T18:48:54.207Z"
}
```

## Example 2: Send a Test Print Job

Send a test print with the default sample data:

```bash
curl -X POST \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  http://localhost:8080/api/debug/print-test | jq .
```

### Expected Response:
```json
{
  "ok": true,
  "jobId": "1760899741668-242fc416-cfc5-4806-8b04-a62e65943f02",
  "receipt": "                             ORDER\nORDER TYPE = DELIVERY\n...",
  "payload": {...},
  "message": "Test print job enqueued successfully"
}
```

## Example 3: Test with Custom Order Data

Test the printer with your own order data:

```bash
curl -X POST \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "items": [
      {
        "name": "Margherita Pizza",
        "quantity": 1,
        "unit_pence": 899,
        "groups": [
          {
            "name": "SIZE",
            "values": ["12 inch"]
          }
        ]
      },
      {
        "name": "Garlic Bread",
        "quantity": 1,
        "unit_pence": 350
      }
    ],
    "delivery_fee_pence": 150,
    "meta": {
      "fulfilment": "delivery",
      "customer": {
        "name": "John Smith",
        "phone": "+447700900123"
      },
      "address": "42 High Street, London, SW1A 1AA"
    }
  }' \
  http://localhost:8080/api/debug/print-test | jq .receipt -r
```

### Expected Output:
```
                             ORDER
ORDER TYPE = DELIVERY
ORDER DATE = ASAP

Name: John Smith
Phone: +447700900123
Address: 42 High Street, London, SW1A 1AA

---------------------------------------------------------------
Margherita Pizza                                          £8.99
SIZE: 12 inch
---------------------------------------------------------------
Garlic Bread                                              £3.50
---------------------------------------------------------------
SUBTOTAL:                                                £12.49
DELIVERY FEE:                                             £1.50
TOTAL:                                                   £13.99
```

## Example 4: Monitor Queue Status

Check how many jobs are in the queue:

```bash
curl -s -H "X-Admin-Token: $ADMIN_TOKEN" \
  http://localhost:8080/api/debug/print-status | jq '.queue.count'
```

## Example 5: View Job Preview

See a preview of what's in the queue:

```bash
curl -s -H "X-Admin-Token: $ADMIN_TOKEN" \
  http://localhost:8080/api/debug/print-status | jq '.queue.jobs[0].preview' -r
```

## Example 6: Check Last Printer Callback

See when the printer last contacted the server:

```bash
curl -s -H "X-Admin-Token: $ADMIN_TOKEN" \
  http://localhost:8080/api/debug/print-status | jq '.lastCallback.when' -r
```

## Troubleshooting

### Issue: "unauthorized" error
Make sure you're using the correct admin token:
```bash
curl -H "X-Admin-Token: wrong-token" http://localhost:8080/api/debug/print-status
# Response: {"error":"unauthorized"}
```

### Issue: Jobs not appearing in queue
1. Check if jobs were added:
   ```bash
   curl -X POST -H "X-Admin-Token: $ADMIN_TOKEN" http://localhost:8080/api/debug/print-test
   ```
2. Verify the queue:
   ```bash
   curl -H "X-Admin-Token: $ADMIN_TOKEN" http://localhost:8080/api/debug/print-status | jq '.queue'
   ```

### Issue: Printer not picking up jobs
Check the printer token status:
```bash
curl -s -H "X-Admin-Token: $ADMIN_TOKEN" \
  http://localhost:8080/api/debug/print-status | jq '.printerToken'
```
If it shows "not_set", configure the PRINTER_TOKEN environment variable.

## Integration with Scripts

### Bash Script Example

```bash
#!/bin/bash
ADMIN_TOKEN="your-token"
API_URL="http://localhost:8080"

# Send test print
echo "Sending test print..."
RESPONSE=$(curl -s -X POST \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  "$API_URL/api/debug/print-test")

JOB_ID=$(echo "$RESPONSE" | jq -r '.jobId')
echo "Job ID: $JOB_ID"

# Wait a moment
sleep 2

# Check status
echo "Checking queue..."
curl -s -H "X-Admin-Token: $ADMIN_TOKEN" \
  "$API_URL/api/debug/print-status" | jq '.queue.count'
```

### Python Script Example

```python
import requests
import json

ADMIN_TOKEN = "your-token"
API_URL = "http://localhost:8080"

headers = {
    "X-Admin-Token": ADMIN_TOKEN,
    "Content-Type": "application/json"
}

# Send test print
response = requests.post(
    f"{API_URL}/api/debug/print-test",
    headers=headers
)
print(f"Test print result: {response.json()}")

# Check status
status = requests.get(
    f"{API_URL}/api/debug/print-status",
    headers=headers
)
print(f"Queue count: {status.json()['queue']['count']}")
```

## Production Usage

These endpoints should be used for debugging and monitoring only. For production monitoring:

1. Set up proper logging and alerting
2. Monitor the queue count to detect issues
3. Check printer callback timestamps to ensure printer connectivity
4. Use the test endpoint during maintenance windows only

## Security Notes

- Always use HTTPS in production
- Keep the admin token secure
- These endpoints are admin-only for a reason
- Don't expose file paths or sensitive data in logs
