#!/bin/bash
# <xbar.title>claudecord</xbar.title>
# <xbar.version>v1.0</xbar.version>
# <xbar.desc>Status + controls for the claudecord Discord bridge daemon</xbar.desc>
# <xbar.dependencies>bun</xbar.dependencies>
#
# SwiftBar/xbar plugin. Install SwiftBar (brew install swiftbar), then symlink
# this file into your plugin folder:
#   ln -s ~/Code/claudecord/extras/claudecord.5s.sh ~/Library/Application\ Support/SwiftBar/Plugins/
# Refreshes every 5 seconds (the .5s. in the filename).

LABEL="com.christianfurr.claudecord"
CLI="$HOME/Code/claudecord/src/cli.ts"
BUN="$HOME/.bun/bin/bun"
REGISTRY="$HOME/.claudecord/sessions.json"

PID=$(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | awk '/pid = /{print $3}')

if [ -n "$PID" ]; then
  ACTIVE=0
  if [ -f "$REGISTRY" ]; then
    ACTIVE=$(python3 -c "import json;d=json.load(open('$REGISTRY'));print(sum(1 for s in d['sessions'].values() if s['status']=='active'))" 2>/dev/null || echo 0)
  fi
  if [ "$ACTIVE" -gt 0 ]; then
    echo "🤖 $ACTIVE"
  else
    echo "🤖"
  fi
else
  echo "🤖💤"
fi

echo "---"
if [ -n "$PID" ]; then
  echo "claudecord running (pid $PID) | color=green"
  echo "Restart | bash='$BUN' param1='$CLI' param2=restart terminal=false refresh=true"
  echo "Stop | bash='$BUN' param1='$CLI' param2=stop terminal=false refresh=true"
else
  echo "claudecord stopped | color=red"
  echo "Start | bash='$BUN' param1='$CLI' param2=start terminal=false refresh=true"
fi
echo "---"
echo "Open Discord | href=discord://"
echo "View logs | bash=/usr/bin/open param1=-a param2=Console param3=$HOME/.claudecord/logs/claudecord.log terminal=false"
