// Provider presets for Akron Browser Bot by akronlogic.com.
// Model names are only defaults shown in the UI — every field is editable,
// so you can point Akron at whatever models your account can access.

export const PROVIDER_PRESETS = [
  {
    key: "akron-desktop",
    label: "Akron Code Desktop (All Models · Zero Key)",
    type: "openai-compatible",
    baseUrl: "http://127.0.0.1:8766/v1",
    models: [
      "akron-default",
      "akron-planner",
      "akron-coder",
      "akron-vision",
      "akron-fast",
      "akron-longctx",
    ],
    keyHint: "not required (auto-shared from Akron Code)",
    docs: "https://github.com/faysaliteng/akron-code",
    noKey: true,
  },
  {
    key: "anthropic",
    label: "Anthropic (Claude)",
    type: "anthropic",
    baseUrl: "https://api.anthropic.com",
    models: [
      "claude-sonnet-4-5",
      "claude-opus-4-1",
      "claude-haiku-4-5",
      "claude-3-7-sonnet-latest",
    ],
    keyHint: "sk-ant-...",
    docs: "https://console.anthropic.com/settings/keys",
  },
  {
    key: "openai",
    label: "OpenAI",
    type: "openai",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "o4-mini"],
    keyHint: "sk-...",
    docs: "https://platform.openai.com/api-keys",
  },
  {
    key: "gemini",
    label: "Google Gemini",
    type: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    models: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],
    keyHint: "AIza...",
    docs: "https://aistudio.google.com/app/apikey",
  },
  {
    key: "openrouter",
    label: "OpenRouter",
    type: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    models: [
      "anthropic/claude-sonnet-4.5",
      "openai/gpt-4o",
      "google/gemini-2.5-pro",
      "meta-llama/llama-3.3-70b-instruct",
    ],
    keyHint: "sk-or-...",
    docs: "https://openrouter.ai/keys",
  },
  {
    key: "groq",
    label: "Groq",
    type: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
    keyHint: "gsk_...",
    docs: "https://console.groq.com/keys",
  },
  {
    key: "deepseek",
    label: "DeepSeek",
    type: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"],
    keyHint: "sk-...",
    docs: "https://platform.deepseek.com/api_keys",
  },
  {
    key: "nvidia",
    label: "NVIDIA NIM",
    type: "openai-compatible",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    models: [
      "nvidia/nemotron-3.5-lightning-30b-a3b",
      "nvidia/nemotron-3.5-bolt-e4b",
      "mistralai/mistral-large-4-1t-a52b",
    ],
    keyHint: "NVIDIA API key",
    docs: "https://build.nvidia.com/",
  },
  {
    key: "freellmapi",
    label: "FreeLLMAPI (local router)",
    type: "openai-compatible",
    baseUrl: "http://localhost:3001/v1",
    models: ["auto"],
    keyHint: "freellmapi-...",
    docs: "https://github.com/tashfeenahmed/freellmapi",
    requiresKey: true,
  },
  {
    key: "tokenrouter",
    label: "TokenRouter",
    type: "openai-compatible",
    baseUrl: "https://api.tokenrouter.com/v1",
    models: ["moonshotai/kimi-k3.1-pro", "deepseek/deepseek-v4.1-flash-1017"],
    keyHint: "sk-...",
    docs: "https://tokenrouter.com",
  },
  {
    key: "xai",
    label: "xAI (Grok)",
    type: "openai-compatible",
    baseUrl: "https://api.x.ai/v1",
    models: ["grok-4", "grok-3", "grok-3-mini"],
    keyHint: "xai-...",
    docs: "https://console.x.ai/",
  },
  {
    key: "mistral",
    label: "Mistral AI",
    type: "openai-compatible",
    baseUrl: "https://api.mistral.ai/v1",
    models: ["mistral-large-latest", "mistral-small-latest"],
    keyHint: "...",
    docs: "https://console.mistral.ai/api-keys",
  },
  {
    key: "together",
    label: "Together AI",
    type: "openai-compatible",
    baseUrl: "https://api.together.xyz/v1",
    models: ["meta-llama/Llama-3.3-70B-Instruct-Turbo"],
    keyHint: "...",
    docs: "https://api.together.ai/settings/api-keys",
  },
  {
    key: "ollama",
    label: "Ollama (local)",
    type: "openai-compatible",
    baseUrl: "http://localhost:11434/v1",
    models: ["llama3.1", "qwen2.5", "mistral"],
    keyHint: "not required",
    docs: "https://ollama.com/",
    noKey: true,
  },
  {
    key: "lmstudio",
    label: "LM Studio (local)",
    type: "openai-compatible",
    baseUrl: "http://localhost:1234/v1",
    models: ["local-model"],
    keyHint: "not required",
    docs: "https://lmstudio.ai/",
    noKey: true,
  },
  {
    key: "custom",
    label: "Custom OpenAI-compatible",
    type: "openai-compatible",
    baseUrl: "",
    models: [],
    keyHint: "your key",
    docs: "",
  },
];

export function presetByKey(key) {
  return PROVIDER_PRESETS.find((p) => p.key === key) || null;
}

export function isLocalBaseUrl(baseUrl) {
  if (!baseUrl) return false;
  try {
    const host = new URL(baseUrl).hostname;
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host.endsWith(".local")
    );
  } catch {
    return false;
  }
}
