# API keys for Akron: where to get them, how to enter them, how to use them

Akron has no account and no server of its own. It talks to an AI provider with
**your** API key. This guide covers every provider Akron has a preset for, plus
three free ones that are added with the **Custom** preset.

Free limits and prices change. Where this guide gives a limit, it was measured
on 25 November 2026; check the provider's own page before you rely on it.

---

## 1. How a key is used

- You paste the key in Akron's Settings. It is stored in the browser's extension
  storage on your computer.
- When you give Akron a task, the browser sends your request **straight to the
  provider** with that key. Nothing passes through akronlogic.com or anyone else.
- The provider bills (or rate-limits) the account the key belongs to.

Akron works with any model that supports **tool calling** (also called function
calling). A model that can also read images is better, because Akron can then
use screenshots.

---

## 2. Enter a key (same steps for every provider)

1. Click the Akron icon to open the side panel, then the **Settings** button at
   the top of the panel.
2. Open **API keys & providers**.
3. Choose the provider in the preset list and click **Add provider**.
   (For a provider with no preset choose **Custom** and type its Base URL.)
4. Paste the key into **API key**.
5. Click **Fetch models from provider**. The model list fills in. If the provider
   has no model list, type the model names yourself, one per line.
6. Click **Test connection**. You should see a success message.
7. Click **Save provider**.
8. Under **Agent settings** choose the active provider and model, and save.

You can add as many providers as you like.

---

## 3. Use it

- **Pick the model** in the side panel header. The change applies to the next
  message.
- **Several keys for one provider**: open the provider in Settings and paste the
  other keys into **Extra API keys for orchestrator**, one per line.
- **Orchestrator mode** (Settings → Orchestrator mode): tick the models that
  should take part. Akron then treats every key × model as one pool. When a key
  hits a rate limit, runs out of quota or the provider has an outage, the same
  step is retried on the next one and the task goes on. This is what makes free
  keys practical: one free key is small, several together are not.
- **Scheduled tasks** use the same provider and pool.

---

## 4. Which provider should I start with?

| You want | Use | Cost |
|---|---|---|
| To try Akron without paying | Groq, NVIDIA NIM, OpenRouter (`:free` models), Google Gemini free tier | Free, with rate limits |
| Free keys that keep a long task going | The free ones above together in Orchestrator mode | Free |
| The most reliable results on hard pages | Anthropic (Claude), OpenAI, Google Gemini on a paid tier | Pay per use |
| Low cost per task | DeepSeek, TokenRouter | Pay per use (prepaid balance) |
| Nothing leaves your computer | Ollama or LM Studio | Free, needs a strong computer |

---

## 5. Provider by provider

For each provider: where the key comes from, what to choose in Akron, and what
it is good for.

### Anthropic (Claude)

- **Get the key:** <https://console.anthropic.com/settings/keys> → **Create
  Key**. The key starts with `sk-ant-`. It is shown once: copy it at once.
  Add credit under **Billing** first; a key without credit answers with an error.
- **In Akron:** preset **Anthropic (Claude)**.
- **Benefits:** the strongest models for browser work (careful reading, good
  tool use, vision). Best choice when a task must not go wrong.
- **Keep in mind:** paid only.

### OpenAI

- **Get the key:** <https://platform.openai.com/api-keys> → **Create new secret
  key**. Starts with `sk-`. Shown once. Needs a payment method or prepaid credit.
- **In Akron:** preset **OpenAI**.
- **Benefits:** strong general models with vision and reliable tool calling.
- **Keep in mind:** paid only. A ChatGPT subscription does not include API use.

### Google Gemini

- **Get the key:** <https://aistudio.google.com/api-keys> → **Create API key**.
  Starts with `AIza`. Existing keys can be opened and copied again later.
- **In Akron:** preset **Google Gemini**.
- **Benefits:** a free tier with no card, vision, a very large context window.
- **Keep in mind:** the free tier is small. In our test a free key was used up
  after about a dozen calls and often answered "high demand". A key that belongs
  to a project with billing ("Tier 1") is charged. Check the tier shown next to
  each key in AI Studio before you paste it.

### Groq

- **Get the key:** <https://console.groq.com/keys> → **Create API Key**. Starts
  with `gsk_`. Shown once. No card needed.
- **In Akron:** preset **Groq**.
- **Benefits:** free tier, and the fastest answers of all providers here.
- **Keep in mind:** the free tier has a per-minute limit. A task of four or five
  steps took 30 to 45 seconds in our test because Akron had to wait between
  steps. Good in an orchestrator pool.

### NVIDIA NIM

- **Get the key:** <https://build.nvidia.com/settings/api-keys> → **Generate API
  Key**. Starts with `nvapi-`. Shown once. You choose when it expires (up to
  12 months).
- **In Akron:** preset **NVIDIA NIM**, then **Fetch models**.
- **Benefits:** free for development, many large models to choose from.
- **Keep in mind:** speed differs a lot between models. Some answered in a few
  seconds, some took more than two minutes. Test a model on a small task before
  you rely on it.

### OpenRouter

- **Get the key:** <https://openrouter.ai/keys> → **Create Key**. Starts with
  `sk-or-`. Shown once.
- **In Akron:** preset **OpenRouter**, then **Fetch models**.
- **Benefits:** one key for hundreds of models from many companies. Models whose
  name ends in `:free` cost nothing, and `openrouter/free` picks a free model
  for you.
- **Keep in mind:** free models have a daily request limit, which is higher once
  the account has bought credits. Paid models are billed from your credit.

### DeepSeek

- **Get the key:** <https://platform.deepseek.com/api_keys> → **Create new API
  key**. Starts with `sk-`. Shown once. Top up a balance under **Top up** first.
- **In Akron:** preset **DeepSeek**.
- **Benefits:** very low price per task, good tool calling.
- **Keep in mind:** prepaid. With a zero balance the key answers "Insufficient
  Balance".

### TokenRouter

- **Get the key:** <https://tokenrouter.com/console/token> → create a token.
  Starts with `sk-`. Shown once.
- **In Akron:** preset **TokenRouter**.
- **Benefits:** one prepaid balance for models from several companies.
- **Keep in mind:** a new token expires after 30 days unless you set a longer
  time when you create it. An expired token answers 401: make a new one and
  replace it in Settings.

### xAI (Grok)

- **Get the key:** <https://console.x.ai/> → **API Keys** → **Create API key**.
- **In Akron:** preset **xAI (Grok)**.
- **Benefits:** fast models with tool calling and vision.
- **Keep in mind:** paid (prepaid credit).

### Mistral AI

- **Get the key:** <https://console.mistral.ai/api-keys> → **Create new key**.
  Shown once.
- **In Akron:** preset **Mistral AI**.
- **Benefits:** European provider, good price, tool calling.
- **Keep in mind:** you must choose a plan in the console before a key works.

### Together AI

- **Get the key:** <https://api.together.ai/settings/api-keys>.
- **In Akron:** preset **Together AI**.
- **Benefits:** many open models on fast hardware.
- **Keep in mind:** when we tried it, the site asked for a credit purchase by
  card before it would create a key.

### Ollama and LM Studio (models on your own computer)

- **Get the key:** none needed. Install [Ollama](https://ollama.com/) or
  [LM Studio](https://lmstudio.ai/), download a model that supports tool
  calling, and start its local server.
- **In Akron:** preset **Ollama (local)** or **LM Studio (local)**. Leave the
  key empty.
- **Benefits:** free, private, works without internet.
- **Keep in mind:** needs a strong computer. Small local models make more
  mistakes in multi-step browser tasks than the hosted ones.

### FreeLLMAPI (local router)

- **Get the key:** run the router from
  <https://github.com/tashfeenahmed/freellmapi>. It gives you one unified key
  that starts with `freellmapi-`.
- **In Akron:** preset **FreeLLMAPI (local router)**. Paste the unified key (it
  is required although the address is local), then **Fetch models**.
- **Benefits:** it spreads requests over several free providers for you.

### Cloudflare Workers AI (added with the Custom preset)

- **Get the key:** <https://dash.cloudflare.com/> → **AI** → **Workers AI** →
  **Use REST API** → **Create a Workers AI API Token**. Copy the token and the
  **Account ID** shown on the same page.
- **In Akron:** preset **Custom**. Base URL:
  `https://api.cloudflare.com/client/v4/accounts/YOUR_ACCOUNT_ID/ai/v1`
  **Fetch models** does not work here (the address answers HTTP 405), so type
  the model names yourself, for example `@cf/openai/gpt-oss-120b`.
- **Benefits:** a free daily allowance, no card.

### Cohere (added with the Custom preset)

- **Get the key:** <https://dashboard.cohere.com/api-keys>. A **trial key** is
  free and can be shown again later.
- **In Akron:** preset **Custom**. Base URL:
  `https://api.cohere.ai/compatibility/v1`
- **Benefits:** free trial key with capable models.
- **Keep in mind:** a trial key is for non-commercial use and allows about
  1,000 calls a month. For business use switch to a production key.

### Kilo (added with the Custom preset)

- **Get the key:** sign in at <https://kilo.ai/> and create an API key in your
  account settings.
- **In Akron:** preset **Custom**. Base URL: `https://api.kilo.ai/api/gateway`
  Then **Fetch models**. Free models have `free` in their name
  (for example `kilo-auto/free`).
- **Benefits:** one key for several free models.

---

## 6. Many keys at once: the local key file

Typing a dozen keys into Settings is slow. Akron can read them from a file
instead:

1. Copy `local-provider.example.json` to `local-provider.json` (same folder as
   `manifest.json`).
2. Put your providers and keys in it.
3. Reload the extension. The providers and the orchestrator pool appear in
   Settings.

`local-provider.json` is ignored by git, so the keys in it are never committed.
The format is described in the README under **Local key file**. Raise the
`version` number in the file whenever you change it, or Akron will not read it
again.

---

## 7. Keep your keys safe

- A key is a password. Do not post it in a chat, a screenshot or an issue.
- Never commit a key. Keep keys only in Akron's Settings or in
  `local-provider.json`.
- Give each key a name on the provider's site (for example "akron") so you can
  delete just that one later.
- Set a spending limit on paid providers.
- If a key may have leaked, delete it on the provider's site and create a new
  one. Deleting it there is what makes it useless.

---

## 8. When something does not work

| What you see | What it means | What to do |
|---|---|---|
| 401 or 403 | The key is wrong, expired or deleted | Paste it again without spaces, or create a new key |
| 402 or "Insufficient balance" | A prepaid account is empty | Top up the balance |
| 404 "model not found" | The model name is not offered to your account | Click **Fetch models** and choose one from the list |
| 429 | Rate limit or free quota used up | Wait, or add more keys and turn on Orchestrator mode |
| 500, 503, 529 | The provider is overloaded | Try again; Orchestrator mode moves to the next endpoint by itself |
| **Fetch models** finds nothing | The provider has no model list | Type the model names by hand |
| Akron answers but never clicks anything | The model does not support tool calling | Choose a model that does |
