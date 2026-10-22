# StudyBuddy 3D

**Upload. Understand. Practice. Remember.**

An AI study assistant with a 3D login, PDF chat with page citations, 5-question exams and 3D spaced-repetition flashcards.

| File | Purpose |
|---|---|
| `index.html` | Page structure (login, dashboard, chat, exam, flashcards) |
| `style.css` | Design system: dark glassmorphism, 3D buttons, card flip, responsive, reduced-motion |
| `script.js` | All app logic: Three.js background, PDF.js, BM25 search, exam, flashcards |
| `server/server.js` | Small backend that keeps your Anthropic API key secret (no npm packages needed) |
| `.env.example` | Settings template. Copy to `.env` |

## How it works

- **PDF upload:** text is extracted page by page in your browser with PDF.js, split into about 500-word chunks with overlap, and each chunk remembers its page numbers.
- **Chat:** a BM25 search finds the 4 best chunks. If the best match is too weak, the app refuses **without calling the AI**. Otherwise only those 4 chunks go to the AI (`claude-sonnet-4-6`), which must cite pages. The app then checks every citation and removes any page that was not in the retrieved text.
- **Exam and flashcards:** the AI writes JSON from your notes; the app validates it (4 options, one correct answer, a real page number) and discards anything malformed.
- **Flashcards:** "Know it" schedules the next review after 1, then 3, then 7 days. "Need more practice" brings the card back and marks the topic as weak.
- **Languages:** English, Hindi (Devanagari) and Hinglish questions. Answers come back in the language you asked in.

## Run it on your computer

You need [Node.js](https://nodejs.org) 18 or newer and an [Anthropic API key](https://console.anthropic.com).

```bash
cp .env.example .env        # Windows: copy .env.example .env
# open .env and paste your key after ANTHROPIC_API_KEY=
npm start
```

Open **http://localhost:3000**. There is nothing to install: the server uses only built-in Node features.

## Put it on GitHub

GitHub Pages hosts only static files, so the website and the server go to two places.

### 1. Push the code

```bash
git init
git add .
git commit -m "StudyBuddy 3D"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/studybuddy-3d.git
git push -u origin main
```

`.env` is listed in `.gitignore`, so your key is never uploaded. Never put the key in any other file.

### 2. Host the server (needed for chat, exams and AI flashcards)

Use any Node host, for example [Render](https://render.com) (free tier) or Railway:

1. Create a new **Web Service** from your GitHub repository.
2. Build command: leave empty. Start command: `npm start`.
3. Add environment variables:
   - `ANTHROPIC_API_KEY` = your key
   - `CORS_ORIGIN` = `https://YOUR-USERNAME.github.io`
   - `TRUST_PROXY` = `1`
4. Deploy and copy the server address, for example `https://studybuddy-api.onrender.com`.

### 3. Publish the website on GitHub Pages

1. In `index.html`, set the server address:
   ```html
   <meta name="studybuddy-api" content="https://studybuddy-api.onrender.com">
   ```
2. Commit and push.
3. In your repository open **Settings → Pages**, choose **Deploy from a branch**, branch `main`, folder `/ (root)`, and save.
4. Your site appears at `https://YOUR-USERNAME.github.io/studybuddy-3d/`.

> If you skip step 2, the site still loads, you can upload PDFs and review existing flashcards, and a red banner explains that AI features are offline.

Alternatively, host everything on the Node service alone: it already serves the website, so leave the `content=""` empty and open the service address.

## Things to know

- **The login is a demo.** It checks the email format and password length in the browser only. There are no accounts and nothing is sent anywhere. Do not type a real password.
- **Saving:** notes, flashcards and progress are saved through `window.storage` when the host provides it. Otherwise they are kept in memory and are lost when the tab closes (a note on the dashboard says so). `localStorage` and `sessionStorage` are never used.
- **PDFs must contain real text.** Scanned or image-only PDFs are rejected with a message. Limits: 25 MB and 400 pages.
- **Privacy:** only the few excerpts needed for a question, exam or card set are sent to the AI through your server.
- **Retrieval threshold:** the "too weak to answer" rule is set in `CONFIG` at the top of `script.js` (`MIN_RELEVANCE`, `MIN_TERM_MATCH`). It was tuned on sample notes; raise it if the assistant answers off-topic questions, lower it if it refuses too often.
- **Internet needed for libraries:** Three.js, PDF.js and the fonts load from public CDNs. If Three.js or WebGL is unavailable, an animated CSS background replaces the 3D scene.
- **Costs:** each question, exam or card set is one Anthropic API call billed to your key. `RATE_LIMIT_PER_MIN` limits each visitor.

## Troubleshooting

| Problem | Fix |
|---|---|
| Red banner "AI features are offline" | Server not running, wrong address in the `studybuddy-api` meta tag, or `CORS_ORIGIN` does not match your site address exactly (no trailing slash) |
| "ANTHROPIC_API_KEY is not set" | Create `.env` from `.env.example` and restart `npm start` |
| "No selectable text was found" | The PDF is scanned. Export it from the original document or run OCR first |
| Every question is refused | Use words that appear in your notes, or lower `MIN_RELEVANCE` slightly |
| Free Render server is slow on the first request | Free services sleep; wait about 30 seconds and retry |

## Controls

- **Flashcards:** `Space` flips, `→` or `K` = Know it, `←` or `P` = Need more practice
- **Exam:** `1`–`4` or `A`–`D` answer, `←` `→` move between questions
- **Chat:** `Enter` sends, `Shift+Enter` adds a new line
