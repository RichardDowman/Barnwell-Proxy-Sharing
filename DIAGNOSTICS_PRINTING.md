# Printing Diagnostics - Checklist & Commands

This file lists reproducible checks to run on the server where the proxy runs.

1) Confirm printer is visible to system (CUPS)
- lpstat -p -d

2) Send a small test print
- printf "TEST PRINT - $(date)\n" > /tmp/print-test.txt
- lp -d PRINTER_NAME /tmp/print-test.txt

3) If app runs in Docker — container checks
- docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"
- docker logs --tail 200 <proxy_container_name>

4) If app runs under systemd
- sudo journalctl -u <proxy_service_name> -n 200 --no-pager

5) If using pm2
- pm2 ls
- pm2 logs <app-name> --lines 200

6) Useful commands for printing troubleshooting
- Check permissions: sudo -u <proxy-user> lp -d PRINTER_NAME /tmp/print-test.txt
- Run a raw text print: cat /tmp/print-test.txt | nc PRINTER_HOST PRINTER_PORT  (if network printer)
- Check environment: env | grep -Ei 'PRINTER|PRINT|PROXY|SQUARE|FIREBASE' || true

7) Save outputs to a file and share:
- /tmp/print-diagnostics-$(date -u +%Y%m%dT%H%M%SZ).txt
