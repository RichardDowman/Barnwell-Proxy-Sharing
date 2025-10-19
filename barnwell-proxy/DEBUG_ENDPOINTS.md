# Printing Debug Endpoints

This document describes the diagnostic endpoints added to help debug the printing system.

## Overview

Two new admin-protected endpoints have been added to help diagnose and test the printing functionality:

1. **Print Status Endpoint** - View the current state of the print queue and recent activity
2. **Print Test Endpoint** - Send test print jobs to verify the system is working

## Authentication

Both endpoints require the `X-Admin-Token` header to be set with the correct admin token (configured via the `ADMIN_TOKEN` environment variable).

**Example:**
```bash
curl -H "X-Admin-Token: your-admin-token-here" http://localhost:8080/api/debug/print-status
```

## Endpoints

### 1. GET /api/debug/print-status

Returns comprehensive information about the printing system status.

**Request:**
```bash
curl -H "X-Admin-Token: your-admin-token" http://localhost:8080/api/debug/print-status
```

**Response:**
```json
{
  "ok": true,
  "queue": {
    "count": 2,
    "jobs": [
      {
        "file": "1760899741668-242fc416-cfc5-4806-8b04-a62e65943f02.txt",
        "path": "/path/to/queue/file.txt",
        "modified": "2025-10-19T18:49:01.667Z",
        "preview": "ORDER\r\nORDER TYPE = DELIVERY\r\n..."
      }
    ]
  },
  "done": {
    "count": 10,
    "recentJobs": [
      {
        "file": "1759743718948-d58c3493-a61c-4067-b9be-4df4491630d1.txt",
        "modified": "2025-10-19T18:46:16.186Z"
      }
    ]
  },
  "lastCallback": {
    "when": "2025-10-02T23:00:55.836Z",
    "ip": "138.68.179.24",
    "body": "..."
  },
  "printerToken": "***set***",
  "timestamp": "2025-10-19T18:48:54.207Z"
}
```

**Response Fields:**
- `queue.count` - Number of jobs waiting to be printed
- `queue.jobs` - Array of queued jobs with file info and preview
- `done.count` - Total number of completed print jobs
- `done.recentJobs` - Last 10 completed jobs
- `lastCallback` - Last callback received from the printer
- `printerToken` - Status of printer token configuration ("***set***" or "not_set")
- `timestamp` - Current server timestamp

### 2. POST /api/debug/print-test

Enqueues a test print job to verify the printing system is working correctly.

**Request with Default Sample Data:**
```bash
curl -X POST \
  -H "X-Admin-Token: your-admin-token" \
  -H "Content-Type: application/json" \
  http://localhost:8080/api/debug/print-test
```

**Request with Custom Data:**
```bash
curl -X POST \
  -H "X-Admin-Token: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{
    "items": [
      {
        "name": "Custom Pizza",
        "quantity": 1,
        "unit_pence": 1200,
        "groups": [
          {
            "name": "SIZE",
            "values": ["Large"]
          },
          {
            "name": "TOPPINGS",
            "values": ["Pepperoni", "Mushrooms"]
          }
        ]
      }
    ],
    "delivery_fee_pence": 0,
    "meta": {
      "fulfilment": "collection",
      "customer": {
        "name": "Test Customer",
        "phone": "+447700123456"
      }
    }
  }' \
  http://localhost:8080/api/debug/print-test
```

**Response:**
```json
{
  "ok": true,
  "jobId": "1760899741668-242fc416-cfc5-4806-8b04-a62e65943f02",
  "receipt": "                             ORDER\nORDER TYPE = COLLECTION\n...",
  "payload": {
    "items": [...],
    "delivery_fee_pence": 0,
    "meta": {...}
  },
  "message": "Test print job enqueued successfully"
}
```

**Response Fields:**
- `jobId` - Unique identifier for the enqueued print job
- `receipt` - The formatted receipt text that will be printed
- `payload` - The order data that was used to generate the receipt
- `message` - Confirmation message

## Use Cases

### Debugging Print Issues

1. **Check if print jobs are queuing:**
   ```bash
   curl -H "X-Admin-Token: TOKEN" http://localhost:8080/api/debug/print-status | jq '.queue.count'
   ```

2. **View what's in the queue:**
   ```bash
   curl -H "X-Admin-Token: TOKEN" http://localhost:8080/api/debug/print-status | jq '.queue.jobs'
   ```

3. **Send a test print:**
   ```bash
   curl -X POST -H "X-Admin-Token: TOKEN" http://localhost:8080/api/debug/print-test
   ```

4. **Verify the test job was queued:**
   ```bash
   curl -H "X-Admin-Token: TOKEN" http://localhost:8080/api/debug/print-status | jq '.queue'
   ```

### Monitoring Printer Activity

Check when the printer last connected:
```bash
curl -H "X-Admin-Token: TOKEN" http://localhost:8080/api/debug/print-status | jq '.lastCallback.when'
```

## Security

- Both endpoints require admin authentication via the `X-Admin-Token` header
- Requests without a valid token will receive a `401 Unauthorized` response
- The admin token must be configured via the `ADMIN_TOKEN` environment variable

## Related Endpoints

- `GET /api/printer-feed.txt` - CloudPRNT endpoint used by printers to fetch jobs
- `POST /api/printer-callback` - Endpoint for printer status callbacks
- `POST /api/admin/print-test` - Original admin test print endpoint (simpler version)
- `POST /api/admin/print-order` - Force print an existing order by reference

## Implementation Notes

- Print jobs are stored as text files in `data/printer/queue/`
- Completed jobs are moved to `data/printer/done/`
- The status endpoint shows the last 10 completed jobs
- Job previews are limited to the first 200 characters
- The receipt format uses 63-character width for Star printers

## Additional Resources

For detailed testing examples and integration code, see [TESTING_EXAMPLES.md](./TESTING_EXAMPLES.md).
