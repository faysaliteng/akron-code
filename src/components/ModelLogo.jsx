import React from 'react';

/**
 * Resolve an AI model/provider/endpoint descriptor into a normalized brand key
 * so every model surface renders an authentic vector brand mark.
 */
export function resolveModelBrand({ model = '', provider = '', baseURL = '', label = '' } = {}) {
  const m = `${String(model || '')} ${String(label || '')}`.toLowerCase();
  const p = `${String(provider || '')} ${String(baseURL || '')}`.toLowerCase();

  // 1. Specific model / family match first
  if (/deepseek|v4\.?1-flash|v4-flash|\br1[-\s/]|\bv3[-\s/]/.test(m)) return 'deepseek';
  if (/claude|opus|sonnet|haiku|fable/.test(m)) return 'claude';
  if (/(?:^|[^a-z])(gpt|chatgpt|codex|dall-e|sora|gpt-image|terra|luna)\b|(?:^|[^a-z])o[134](?:-mini|-preview|-pro|\b)/.test(m)) return 'openai';
  if (/gemini|gemma|imagen|veo|argon|carbon|hydrogen|neon|agnes|learnlm|palm|antigravity/.test(m)) return 'gemini';
  if (/grok|aurora/.test(m)) return 'grok';
  if (/llama|codellama|meta-llama/.test(m)) return 'meta';
  if (/qwen|qwq|qvq|tongyi|\bwan[-0-9]/.test(m)) return 'qwen';
  if (/mistral|mixtral|codestral|pixtral|ministral|magistral|devstral/.test(m)) return 'mistral';
  if (/flux|schnell|kontext|black-forest/.test(m)) return 'flux';
  if (/command-r|command-a|c4ai|\baya\b|cohere/.test(m)) return 'cohere';
  if (/sonar|r1-1776|perplexity/.test(m)) return 'perplexity';
  if (/kimi|moonshot/.test(m)) return 'kimi';
  if (/\bglm|chatglm|cogview|codegeex|zhipu/.test(m)) return 'glm';
  if (/minimax|abab|hailuo/.test(m)) return 'minimax';
  if (/\bphi[-0-9]|wizardlm|\bmai-/.test(m)) return 'microsoft';
  if (/nemotron|nvidia|cosmos/.test(m)) return 'nvidia';
  if (/starcoder|smollm|zephyr|huggingface/.test(m)) return 'huggingface';
  if (/orchestrator|swarm/.test(m)) return 'orchestrator';
  if (/magidonia|pollinations|chutes|featherless/.test(m)) return 'freellm';
  if (/^\s*auto\s*$/i.test(String(model || ''))) return 'deepseek';

  // 2. Provider / endpoint fallback (check Ollama before Meta/Llama since "ollama" contains "llama")
  if (/ollama|:11434\b/.test(p)) return 'ollama';
  if (/lm\s*studio|lmstudio|:1234\b/.test(p) || /local-model/.test(m)) return 'lmstudio';
  if (/deepseek|api\.deepseek/.test(p)) return 'deepseek';
  if (/anthropic|claude/.test(p)) return 'claude';
  if (/openai|chatgpt|api\.openai/.test(p)) return 'openai';
  if (/google|gemini|antigravity|generativelanguage\.googleapis/.test(p)) return 'gemini';
  if (/xai|x\.ai|grok/.test(p)) return 'grok';
  if (/(?:^|[^a-z])(meta|llama)\b/.test(p)) return 'meta';
  if (/qwen|alibaba|dashscope/.test(p)) return 'qwen';
  if (/mistral/.test(p)) return 'mistral';
  if (/openrouter/.test(p)) return 'openrouter';
  if (/freellm|:3001\b|:31415\b/.test(p)) return 'freellm';
  if (/cohere/.test(p)) return 'cohere';
  if (/perplexity/.test(p)) return 'perplexity';
  if (/nvidia/.test(p)) return 'nvidia';
  if (/huggingface|hf\.co/.test(p)) return 'huggingface';
  if (/moonshot|kimi/.test(p)) return 'kimi';
  if (/zhipu|bigmodel|glm/.test(p)) return 'glm';
  if (/minimax/.test(p)) return 'minimax';
  if (/microsoft|azure/.test(p)) return 'microsoft';
  if (/black-forest|\bbfl\b|flux/.test(p)) return 'flux';
  if (/orchestrator|pool|swarm/.test(p)) return 'orchestrator';

  return 'generic';
}

const BRAND_TITLE = {
  deepseek: 'DeepSeek',
  claude: 'Anthropic Claude',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  grok: 'xAI Grok',
  meta: 'Meta Llama',
  qwen: 'Alibaba Qwen',
  mistral: 'Mistral AI',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  flux: 'Black Forest Labs Flux',
  cohere: 'Cohere',
  perplexity: 'Perplexity',
  kimi: 'Moonshot Kimi',
  glm: 'Zhipu GLM',
  minimax: 'MiniMax',
  microsoft: 'Microsoft Phi',
  nvidia: 'NVIDIA',
  openrouter: 'OpenRouter',
  huggingface: 'Hugging Face',
  freellm: 'FreeLLMAPI',
  orchestrator: 'Orchestrator',
  generic: 'AI Model',
};

function renderBrandSvg(brand, uid) {
  switch (brand) {
    case 'deepseek': {
      // DeepSeek iconic blue whale silhouette
      const gId = `ds-${uid}`;
      return (
        <>
          <defs>
            <linearGradient id={gId} x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#60A5FA" />
              <stop offset="100%" stopColor="#3B5BDB" />
            </linearGradient>
          </defs>
          <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill={`url(#${gId})`} fillOpacity="0.16" stroke="#4D6BFE" strokeOpacity="0.55" strokeWidth="1" />
          {/* Whale body + curved tail */}
          <path
            d="M19.8 10.6c-.4-.3-.9-.1-1.3.2-.6.5-1.2 1.2-1.8 1.3-.3 0-.5-.2-.6-.5-.4-1.8-1.6-4.2-4.6-4.9-1.7-.4-3.7.1-5.2 1.4-1.6 1.4-2.5 3.6-2 5.7.5 2.1 2.4 3.5 4.9 3.8 2.6.3 5.2-.7 6.8-2.6.8-.9 1.6-2 2.4-2.7.5-.4 1.1-.8 1.5-1.1.3-.2.3-.4-.1-.6Z"
            fill="#4D6BFE"
          />
          {/* Dorsal crest / water spout accent */}
          <path
            d="M9.6 5.2c-.2-.9.5-1.7 1.3-1.7.5 0 .9.3 1.1.7.4-.3 1-.3 1.3.1.4.4.3 1-.2 1.4-.9-.2-2-.3-3.5-.5Z"
            fill="#748FFC"
          />
          {/* Whale belly curve */}
          <path
            d="M5.8 14.3c1.6 1.6 4.4 2.1 6.9 1.3 1.2-.4 2.2-1.1 2.9-1.9-1.5.8-3.4 1.1-5.2.8-1.7-.3-3.4-.9-4.6-2.1v1.9Z"
            fill="#93C5FD"
            fillOpacity="0.85"
          />
          {/* Eye */}
          <circle cx="8.1" cy="11.4" r="0.9" fill="#EFF6FF" />
        </>
      );
    }

    case 'claude': {
      // Anthropic Claude terracotta sunburst
      return (
        <>
          <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="#D97757" fillOpacity="0.18" stroke="#D97757" strokeOpacity="0.5" strokeWidth="1" />
          <g stroke="#E28464" strokeWidth="1.85" strokeLinecap="round">
            <line x1="12" y1="4.7" x2="12" y2="9.4" />
            <line x1="12" y1="14.6" x2="12" y2="19.3" />
            <line x1="4.7" y1="12" x2="9.4" y2="12" />
            <line x1="14.6" y1="12" x2="19.3" y2="12" />
            <line x1="6.8" y1="6.8" x2="10.1" y2="10.1" />
            <line x1="13.9" y1="13.9" x2="17.2" y2="17.2" />
            <line x1="17.2" y1="6.8" x2="13.9" y2="10.1" />
            <line x1="10.1" y1="13.9" x2="6.8" y2="17.2" />
            <line x1="9.2" y1="5.2" x2="10.9" y2="9.6" />
            <line x1="13.1" y1="14.4" x2="14.8" y2="18.8" />
            <line x1="5.2" y1="14.8" x2="9.6" y2="13.1" />
            <line x1="14.4" y1="10.9" x2="18.8" y2="9.2" />
          </g>
        </>
      );
    }

    case 'openai': {
      // OpenAI 6-petal interlocking blossom knot
      return (
        <>
          <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="#10A37F" fillOpacity="0.15" stroke="#10A37F" strokeOpacity="0.5" strokeWidth="1" />
          <g fill="none" stroke="#10B981" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 4.8a3.2 3.2 0 0 1 2.8 1.6l3.4 5.9-2.8 1.6-3.4-5.9" />
            <path d="M18.2 8.4a3.2 3.2 0 0 1 0 3.2l-3.4 5.9-2.8-1.6 3.4-5.9" />
            <path d="M18.2 15.6a3.2 3.2 0 0 1-2.8 1.6H8.6V14h6.8" />
            <path d="M12 19.2a3.2 3.2 0 0 1-2.8-1.6L5.8 11.7l2.8-1.6 3.4 5.9" />
            <path d="M5.8 15.6a3.2 3.2 0 0 1 0-3.2l3.4-5.9 2.8 1.6-3.4 5.9" />
            <path d="M5.8 8.4a3.2 3.2 0 0 1 2.8-1.6h6.8V10H8.6" />
          </g>
        </>
      );
    }

    case 'gemini': {
      // Google Gemini 4-point curved star gradient
      const gId = `gem-${uid}`;
      return (
        <>
          <defs>
            <linearGradient id={gId} x1="4" y1="4" x2="20" y2="20" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#4285F4" />
              <stop offset="52%" stopColor="#9B72CB" />
              <stop offset="100%" stopColor="#D96570" />
            </linearGradient>
          </defs>
          <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill={`url(#${gId})`} fillOpacity="0.16" stroke={`url(#${gId})`} strokeOpacity="0.5" strokeWidth="1" />
          <path
            d="M12 3.6c.5 4.6 3.8 7.9 8.4 8.4-4.6.5-7.9 3.8-8.4 8.4-.5-4.6-3.8-7.9-8.4-8.4 4.6-.5 7.9-3.8 8.4-8.4Z"
            fill={`url(#${gId})`}
          />
        </>
      );
    }

    case 'grok': {
      // xAI Grok orbital slash mark
      return (
        <>
          <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="#0F172A" stroke="#94A3B8" strokeOpacity="0.55" strokeWidth="1" />
          <path d="M16.9 6.6A6.3 6.3 0 1 0 17.6 15" fill="none" stroke="#F8FAFC" strokeWidth="1.75" strokeLinecap="round" />
          <path d="M7.2 16.8L17.4 6.2" stroke="#F8FAFC" strokeWidth="1.95" strokeLinecap="round" />
          <path d="M8.5 7.6L15.6 16.4" stroke="#CBD5E1" strokeWidth="1.55" strokeLinecap="round" />
        </>
      );
    }

    case 'meta': {
      // Meta continuous infinity loop
      const gId = `meta-${uid}`;
      return (
        <>
          <defs>
            <linearGradient id={gId} x1="3" y1="8" x2="21" y2="16" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#0668E1" />
              <stop offset="100%" stopColor="#38BDF8" />
            </linearGradient>
          </defs>
          <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="#0668E1" fillOpacity="0.16" stroke="#38BDF8" strokeOpacity="0.48" strokeWidth="1" />
          <path
            d="M4.6 13.4c0-2.5 1.5-4.7 3.4-4.7 1.6 0 2.9 1.6 4 3.4 1.1-1.8 2.4-3.4 4-3.4 1.9 0 3.4 2.2 3.4 4.7 0 2.1-1.3 3.6-2.9 3.6-1.5 0-2.6-1.1-4.5-4.1-1.9 3-3 4.1-4.5 4.1-1.6 0-2.9-1.5-2.9-3.6Z"
            fill="none"
            stroke={`url(#${gId})`}
            strokeWidth="2.1"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      );
    }

    case 'qwen': {
      // Alibaba Qwen violet geometric hex-star crest
      const gId = `qwen-${uid}`;
      return (
        <>
          <defs>
            <linearGradient id={gId} x1="4" y1="4" x2="20" y2="20" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#8B5CF6" />
              <stop offset="100%" stopColor="#6366F1" />
            </linearGradient>
          </defs>
          <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="#7C3AED" fillOpacity="0.17" stroke="#8B5CF6" strokeOpacity="0.52" strokeWidth="1" />
          <path
            d="M12 4.5l5.8 3.4v6.6l-5.8 3.4-5.8-3.4V7.9L12 4.5Z"
            fill="none"
            stroke={`url(#${gId})`}
            strokeWidth="1.75"
            strokeLinejoin="round"
          />
          <circle cx="12" cy="11.2" r="2.3" fill="#A78BFA" />
          <path d="M14.2 14.2l2.9 2.9" stroke="#C4B5FD" strokeWidth="1.8" strokeLinecap="round" />
        </>
      );
    }

    case 'mistral': {
      // Mistral AI multi-tone pixel M blocks
      return (
        <>
          <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="#F97316" fillOpacity="0.16" stroke="#FB923C" strokeOpacity="0.5" strokeWidth="1" />
          <rect x="5" y="6" width="2.8" height="2.6" fill="#FACC15" />
          <rect x="16.2" y="6" width="2.8" height="2.6" fill="#FACC15" />
          <rect x="5" y="8.8" width="5.2" height="2.6" fill="#F59E0B" />
          <rect x="13.8" y="8.8" width="5.2" height="2.6" fill="#F59E0B" />
          <rect x="5" y="11.6" width="14" height="2.6" fill="#F97316" />
          <rect x="5" y="14.4" width="2.8" height="3.2" fill="#EA580C" />
          <rect x="10.6" y="14.4" width="2.8" height="3.2" fill="#EA580C" />
          <rect x="16.2" y="14.4" width="2.8" height="3.2" fill="#EA580C" />
        </>
      );
    }

    case 'ollama': {
      // Ollama white llama silhouette badge
      return (
        <>
          <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="#E2E8F0" fillOpacity="0.14" stroke="#E2E8F0" strokeOpacity="0.52" strokeWidth="1" />
          {/* Llama ears + head + muzzle */}
          <path
            d="M8.5 5.2l.8 3.2c.8-.3 1.7-.4 2.7-.4s1.9.1 2.7.4l.8-3.2c.2-.6 1-.6 1.2 0l.8 3.9c.7.9 1.1 2.1 1.1 3.4 0 3.2-2.6 5.6-6.6 5.6s-6.6-2.4-6.6-5.6c0-1.3.4-2.5 1.1-3.4l.8-3.9c.2-.6 1-.6 1.2 0Z"
            fill="#F8FAFC"
            fillOpacity="0.92"
          />
          <circle cx="9.6" cy="11.6" r="0.95" fill="#0F172A" />
          <circle cx="14.4" cy="11.6" r="0.95" fill="#0F172A" />
          <path d="M10.7 14.1h2.6l-1.3 1.4-1.3-1.4Z" fill="#0F172A" />
        </>
      );
    }

    case 'lmstudio': {
      // LM Studio isometric purple/cyan cube with M
      const gId = `lms-${uid}`;
      return (
        <>
          <defs>
            <linearGradient id={gId} x1="4" y1="4" x2="20" y2="20" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#A855F7" />
              <stop offset="100%" stopColor="#38BDF8" />
            </linearGradient>
          </defs>
          <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="#9333EA" fillOpacity="0.18" stroke="#A855F7" strokeOpacity="0.55" strokeWidth="1" />
          <polygon points="12,4.5 18.5,8.2 18.5,15.8 12,19.5 5.5,15.8 5.5,8.2" fill={`url(#${gId})`} fillOpacity="0.22" stroke={`url(#${gId})`} strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M8.3 14.5V9.5l3.7 3.2 3.7-3.2v5" fill="none" stroke="#F3E8FF" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </>
      );
    }

    case 'flux': {
      // Black Forest Labs Flux prism mark
      return (
        <>
          <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="#10B981" fillOpacity="0.16" stroke="#34D399" strokeOpacity="0.5" strokeWidth="1" />
          <path d="M6.5 17.5L12 5.5l5.5 12H14l-2-4.6-2 4.6H6.5Z" fill="#34D399" />
          <path d="M9.6 14.5h4.8" stroke="#064E3B" strokeWidth="1.5" strokeLinecap="round" />
        </>
      );
    }

    case 'cohere': {
      // Cohere layered coral/teal pebbles
      return (
        <>
          <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="#FF7759" fillOpacity="0.16" stroke="#FF7759" strokeOpacity="0.5" strokeWidth="1" />
          <circle cx="9.2" cy="9.2" r="3.4" fill="#FF7759" />
          <rect x="12.2" y="7" width="6.2" height="4.4" rx="2.2" fill="#39D3B3" />
          <rect x="6" y="13.2" width="12" height="4.4" rx="2.2" fill="#D183C9" />
        </>
      );
    }

    case 'perplexity': {
      // Perplexity turquoise 8-spoke crystal prism
      return (
        <>
          <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="#20B8CD" fillOpacity="0.16" stroke="#20B8CD" strokeOpacity="0.5" strokeWidth="1" />
          <g stroke="#22D3EE" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" fill="none">
            <line x1="12" y1="4.6" x2="12" y2="19.4" />
            <line x1="5.6" y1="12" x2="18.4" y2="12" />
            <path d="M7.2 6.8l4.8 4.4 4.8-4.4" />
            <path d="M7.2 17.2l4.8-4.4 4.8 4.4" />
            <rect x="7.4" y="8.4" width="9.2" height="7.2" rx="1" />
          </g>
        </>
      );
    }

    case 'kimi': {
      // Moonshot Kimi crescent + orbit dot
      return (
        <>
          <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="#38BDF8" fillOpacity="0.15" stroke="#38BDF8" strokeOpacity="0.5" strokeWidth="1" />
          <path d="M14.8 6.4a6.2 6.2 0 1 0 2.6 9.8 5.1 5.1 0 1 1-2.6-9.8Z" fill="#7DD3FC" />
          <circle cx="16.2" cy="8.5" r="1.5" fill="#BAE6FD" />
        </>
      );
    }

    case 'glm': {
      // Zhipu GLM blue hex shield
      return (
        <>
          <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="#2563EB" fillOpacity="0.16" stroke="#3B82F6" strokeOpacity="0.5" strokeWidth="1" />
          <polygon points="12,5 18,8.5 18,15.5 12,19 6,15.5 6,8.5" fill="none" stroke="#60A5FA" strokeWidth="1.7" strokeLinejoin="round" />
          <path d="M9.4 12h5.2M12 9.4v5.2" stroke="#93C5FD" strokeWidth="1.7" strokeLinecap="round" />
        </>
      );
    }

    case 'minimax': {
      // MiniMax magenta-coral wave
      return (
        <>
          <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="#EC4899" fillOpacity="0.16" stroke="#F43F5E" strokeOpacity="0.5" strokeWidth="1" />
          <path d="M5.5 15.5V9.5l3.2 4 3.3-4.5 3.3 4.5 3.2-4v6" fill="none" stroke="#F472B6" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
        </>
      );
    }

    case 'microsoft': {
      // Microsoft 4-pane window mark
      return (
        <>
          <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="#00A4EF" fillOpacity="0.14" stroke="#38BDF8" strokeOpacity="0.45" strokeWidth="1" />
          <rect x="5.8" y="5.8" width="5.5" height="5.5" rx="0.8" fill="#F25022" />
          <rect x="12.7" y="5.8" width="5.5" height="5.5" rx="0.8" fill="#7FBA00" />
          <rect x="5.8" y="12.7" width="5.5" height="5.5" rx="0.8" fill="#00A4EF" />
          <rect x="12.7" y="12.7" width="5.5" height="5.5" rx="0.8" fill="#FFB900" />
        </>
      );
    }

    case 'nvidia': {
      // NVIDIA green eye spiral
      return (
        <>
          <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="#76B900" fillOpacity="0.17" stroke="#76B900" strokeOpacity="0.55" strokeWidth="1" />
          <path d="M4.8 12c2.1-3.4 4.8-4.8 7.6-4.8 3.2 0 5.9 2.1 6.8 4.8-1.1 2.7-3.6 4.8-6.8 4.8-2.6 0-4.9-1.2-6.3-3.2" fill="none" stroke="#84CC16" strokeWidth="1.75" strokeLinecap="round" />
          <circle cx="12.2" cy="12" r="2.2" fill="#84CC16" />
        </>
      );
    }

    case 'openrouter': {
      // OpenRouter split routing arrows
      return (
        <>
          <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="#6366F1" fillOpacity="0.17" stroke="#818CF8" strokeOpacity="0.52" strokeWidth="1" />
          <path d="M5.5 12h4.2c1.8 0 2.5-3.8 4.6-3.8h3.7M9.7 12c1.8 0 2.5 3.8 4.6 3.8h3.7" fill="none" stroke="#A5B4FC" strokeWidth="1.75" strokeLinecap="round" />
          <path d="M16.2 6.4l2 1.8-2 1.8M16.2 14l2 1.8-2 1.8" fill="none" stroke="#C7D2FE" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </>
      );
    }

    case 'huggingface': {
      // Hugging Face warm amber smiling face badge
      return (
        <>
          <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="#FACC15" fillOpacity="0.16" stroke="#FBBF24" strokeOpacity="0.52" strokeWidth="1" />
          <circle cx="12" cy="12" r="6.2" fill="#FDE047" />
          <circle cx="9.8" cy="10.8" r="0.95" fill="#78350F" />
          <circle cx="14.2" cy="10.8" r="0.95" fill="#78350F" />
          <path d="M9.4 13.4c.7 1.1 1.6 1.6 2.6 1.6s1.9-.5 2.6-1.6" fill="none" stroke="#78350F" strokeWidth="1.45" strokeLinecap="round" />
        </>
      );
    }

    case 'freellm': {
      // FreeLLMAPI emerald unified router prism hub
      return (
        <>
          <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="#10B981" fillOpacity="0.18" stroke="#34D399" strokeOpacity="0.55" strokeWidth="1" />
          <polygon points="12,4.8 18.2,8.4 18.2,15.6 12,19.2 5.8,15.6 5.8,8.4" fill="#10B981" fillOpacity="0.22" stroke="#34D399" strokeWidth="1.5" strokeLinejoin="round" />
          <circle cx="12" cy="12" r="2.1" fill="#6EE7B7" />
          <path d="M12 5.2v4.6M17.8 15.2l-4-2.2M6.2 15.2l4-2.2" stroke="#A7F3D0" strokeWidth="1.35" strokeLinecap="round" />
        </>
      );
    }

    case 'orchestrator': {
      // Orchestrator multi-model constellation triad
      const gId = `orch-${uid}`;
      return (
        <>
          <defs>
            <linearGradient id={gId} x1="4" y1="4" x2="20" y2="20" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#34D399" />
              <stop offset="100%" stopColor="#38BDF8" />
            </linearGradient>
          </defs>
          <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="#10B981" fillOpacity="0.16" stroke="#34D399" strokeOpacity="0.5" strokeWidth="1" />
          <path d="M12 6.8L7.2 15.8h9.6L12 6.8Z" fill="none" stroke={`url(#${gId})`} strokeWidth="1.45" strokeLinejoin="round" />
          <circle cx="12" cy="6.8" r="2" fill="#34D399" />
          <circle cx="7.2" cy="15.8" r="2" fill="#38BDF8" />
          <circle cx="16.8" cy="15.8" r="2" fill="#A78BFA" />
        </>
      );
    }

    default: {
      // Clean neutral AI hexagonal chip logo for unlisted models
      return (
        <>
          <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="#94A3B8" fillOpacity="0.14" stroke="#94A3B8" strokeOpacity="0.45" strokeWidth="1" />
          <polygon points="12,5.6 17.2,8.6 17.2,15.4 12,18.4 6.8,15.4 6.8,8.6" fill="none" stroke="#CBD5E1" strokeWidth="1.5" strokeLinejoin="round" />
          <circle cx="12" cy="12" r="2.1" fill="#E2E8F0" />
        </>
      );
    }
  }
}

export function ModelLogo({ model = '', provider = '', baseURL = '', label = '', size = 15, className = '', title, style }) {
  const uid = React.useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const brand = resolveModelBrand({ model, provider, baseURL, label });
  const resolvedTitle = title || BRAND_TITLE[brand] || 'AI Model';
  return (
    <span
      className={`model-logo model-logo-${brand} ${className}`.trim()}
      data-brand={brand}
      title={resolvedTitle}
      aria-hidden={title ? undefined : true}
      style={{
        width: size,
        height: size,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        ...style,
      }}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        width={size}
        height={size}
        style={{ display: 'block' }}
      >
        {renderBrandSvg(brand, uid)}
      </svg>
    </span>
  );
}

export default ModelLogo;
