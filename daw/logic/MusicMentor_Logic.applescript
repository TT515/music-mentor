(*
MusicMentor for Logic Pro — sends the current session to Music Mentor.

What it does:
  1. Creates/clears the export folder  ~/MusicMentorDrop
  2. Triggers Logic's  File → Export → All Tracks as Audio Files…  menu
  3. You point Logic's export sheet at MusicMentorDrop and click Export
     (Logic remembers the folder — after the first time it's one click)
  4. Waits until the exported stems stop growing (export finished)
  5. Uploads every stem and opens Music Mentor with the session loaded

Install (one time):
  osacompile -o "$HOME/Applications/MusicMentor for Logic.app" MusicMentor_Logic.applescript
  Then run the app once — macOS will ask you to allow it under
  System Settings → Privacy & Security → Accessibility (needed to click
  Logic's menu), and to allow it to control Logic Pro / System Events.

Requires: mentor-send.sh from this repo (path set below).
*)

property uploaderPath : "$HOME/music-mentor-web/daw/logic-fl/mentor-send.sh"

on run
	-- 1. prepare the drop folder
	set dropPath to (POSIX path of (path to home folder)) & "MusicMentorDrop"
	do shell script "mkdir -p " & quoted form of dropPath
	do shell script "rm -f " & quoted form of dropPath & "/*.wav " & quoted form of dropPath & "/*.aif " & quoted form of dropPath & "/*.aiff 2>/dev/null || true"

	-- 2. trigger Logic's export menu
	tell application "Logic Pro" to activate
	delay 1

	set exportTriggered to false
	try
		tell application "System Events"
			tell process "Logic Pro"
				set exportMenu to menu 1 of menu item "Export" of menu 1 of menu bar item "File" of menu bar 1
				click (first menu item of exportMenu whose name contains "All Tracks as Audio Files")
				set exportTriggered to true
			end tell
		end tell
	end try

	if not exportTriggered then
		display dialog "Couldn't reach Logic's Export menu." & return & return & "Checks: is a project open? Does this app have Accessibility permission (System Settings → Privacy & Security → Accessibility)?" & return & return & "Manual fallback: File → Export → All Tracks as Audio Files… → save into MusicMentorDrop, then run this app again." buttons {"OK"} default button 1
		return
	end if

	-- 3. the one manual step: Logic's export sheet
	display dialog "Logic's export sheet is open." & return & return & "1) Set the save folder to  MusicMentorDrop  (in your home folder) — Logic will remember it" & return & "2) Format: WAV" & return & "3) Click Export" & return & return & "Click Continue AFTER clicking Export in Logic." buttons {"Cancel", "Continue"} default button "Continue"

	-- 4. wait until exported files exist and stop changing
	set lastSig to "start"
	set stableCount to 0
	set sawFiles to false
	repeat 600 times -- poll every 3 s, up to 30 min
		delay 3
		set sig to do shell script "cd " & quoted form of dropPath & " 2>/dev/null && { ls -l *.wav *.aif *.aiff 2>/dev/null | awk '{print $5, $9}' | md5; } || echo none"
		if sig is not "none" then
			set sawFiles to true
			if sig is equal to lastSig then
				set stableCount to stableCount + 1
				if stableCount is greater than or equal to 2 then exit repeat
			else
				set stableCount to 0
			end if
		end if
		set lastSig to sig
	end repeat

	if not sawFiles then
		display dialog "No exported audio ever appeared in MusicMentorDrop — the export may have gone to a different folder. Check Logic's export sheet next time." buttons {"OK"} default button 1
		return
	end if

	-- 5. upload and open the mentor
	set shPath to do shell script "eval echo " & quoted form of uploaderPath
	try
		do shell script "/bin/bash " & quoted form of shPath & " " & quoted form of dropPath & " 'Logic session' > /tmp/musicmentor_logic.log 2>&1"
		display dialog "Session sent — Music Mentor is opening in your browser." & return & "(Upload log: /tmp/musicmentor_logic.log)" buttons {"Done"} default button 1
	on error
		display dialog "Upload step failed. Open Terminal and check:  cat /tmp/musicmentor_logic.log" & return & return & "Most common cause: mentor-send.sh not found at " & uploaderPath & " — edit the uploaderPath property at the top of this script." buttons {"OK"} default button 1
	end try
end run
