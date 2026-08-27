# demo/see-and-steer.tape — VHS storyboard for OpenSwarm's
# "see and steer your swarm" demo gif (README hero + launch post).
#
#   vhs demo/see-and-steer.tape   →   demo/see-and-steer.gif
#
# Fully deterministic + zero API spend: `team watch` renders a curated
# events.jsonl (see demo/README.md). `team start` / `team send` are
# log-driven shims defined in demo/demo-env.sh.

Output demo/see-and-steer.gif

Set Shell "bash"
Set FontSize 18
Set Width 1000
Set Height 880
Set Padding 22
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms

# --- hidden setup: load env + shim, reset state, clear screen ---------------
Hide
Type "source demo/demo-env.sh && osw_demo_clean && clear"
Enter
Sleep 800ms
Show

# --- beat 1: start the team (detached) --------------------------------------
Type "openswarm team start review --detach"
Sleep 500ms
Enter
Sleep 1200ms

# --- beat 2: SEE — watch the live multi-pane board fill in ------------------
Type "openswarm team watch review"
Sleep 400ms
Enter
Sleep 11s
Ctrl+C
Sleep 900ms

# --- beat 3: STEER — send a mid-run instruction -----------------------------
Type `openswarm team send review "also check error handling"`
Sleep 500ms
Enter
Sleep 1200ms

# --- beat 4: SEE the swarm react to the steer -------------------------------
Type "openswarm team watch review"
Sleep 400ms
Enter
Sleep 6500ms
Ctrl+C
Sleep 1500ms
