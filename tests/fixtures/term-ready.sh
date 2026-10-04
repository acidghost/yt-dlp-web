#!/bin/sh
# A single ordinary leader exits promptly on TERM. No descendants to keep its
# group live while Bun reaps it, exercising Darwin's zombie-only group race.
printf ready > "$1"
exec sleep 30
