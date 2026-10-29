# Voice Desk

An AI calling platform built on Sarvam AI. Upload a contact list, design an agent (language, voice, script, AI settings) from the dashboard, and place calls. Every call is transcribed and summarised, and the agent remembers earlier calls with each contact.

The browser only talks to this app's own `/api`. Your Sarvam key and telephony credentials stay on the server.

## How a call works

```
Twilio dials the contact ──► agent plays the opening line (Sarvam Bulbul TTS)
        ▲                                         │
        │                          caller speaks, Twilio records the turn
        │                                         ▼
  play reply ◄── Sarvam Bulbul TTS ◄── Sarvam LLM (with memory) ◄── Sarvam Saaras STT
        ...repeat until the agent ends the call...
call ends ──► Sarvam LLM writes the summary, outcome and next action ──► saved to the contact's memory
```

Memory: each new call to a contact gets the summaries of up to three earlier conversations. With "Open follow-up calls by recalling the last conversation" turned on, the agent's first sentence also refers back to the last call.

## Setup

1. Install Node.js 20 or newer, then run `npm install`.
2. Copy `.env.example` to `.env` and set at least `SARVAM_API_KEY`. Set `APP_PASSWORD` if anyone other than you can reach the server.
3. Run `npm start` and open http://localhost:3000.

At this point **browser test calls** work. You talk to the agent through your microphone, and you get the same transcripts, summaries and memory as on a phone call.

### Real phone calls (Twilio)

1. Create a Twilio account and buy or verify a number that can call your target country.
2. Expose the server over HTTPS, for example with `ngrok http 3000`.
3. Fill in `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, and `PUBLIC_BASE_URL` (the ngrok URL) in `.env`, then restart.

The sidebar shows "Phone line" in green once phone calling is set up. Before calling Indian numbers, check the TRAI/DND rules that apply to your use case.

## Using it

1. **Contacts**: upload a CSV with a `phone` column. `name` and every other column (city, due_amount…) become `{{variables}}`. Use `public/sample-contacts.csv` as an example.
2. **Agents → New agent**:
   1. Choose the language.
   2. Describe the call's purpose, then press **Generate script**. Sarvam writes the instructions, opening line, silence prompt and goodbye line. Edit them as needed.
   3. Pick a Bulbul model and voice. Use ▶ to preview a voice.
   4. Set the LLM and memory options.
3. **Test call**: talk to the agent in the browser, optionally as one of your contacts so it uses their memory.
4. **Contacts**: tick contacts, choose an agent, and press **Call selected**. Calls are queued. `MAX_CONCURRENT_CALLS` sets how many run at once.
5. **Call logs**: open any call to see its summary, outcome, key points, next action, transcript and recording.

## Project layout

| Path | What it does |
|---|---|
| `server/index.js` | Express app, login, static files |
| `server/routes/api.js` | Dashboard API |
| `server/routes/twilio.js` | Live call webhooks (one turn per caller utterance) |
| `server/engine.js` | Prompts, memory, turn handling, summaries, dialling queue |
| `server/sarvam.js` | Sarvam TTS, STT and chat client |
| `server/telephony.js` | Twilio REST adapter and webhook signature check |
| `public/` | Dashboard (plain HTML/CSS/JS) |
| `data/` | `db.json` (contacts, agents, calls) and generated audio. Created at runtime. |

## Notes and limits

- Turns are taken one at a time: the caller speaks, pauses for about 2 seconds, then the agent replies. Each reply takes roughly 2–5 seconds (speech-to-text, then the LLM, then text-to-speech). If replies feel slow, set the agent's "Thinking effort" to Low.
- Each caller turn can be up to 28 seconds long, because Sarvam's speech-to-text REST endpoint accepts at most 30 seconds of audio.
- To use Exotel, Plivo or another provider instead of Twilio, write a new `server/telephony.js` with the same exports and matching webhooks.
- Storage is a JSON file, which suits up to a few thousand contacts. For more, move to a database such as Postgres.
