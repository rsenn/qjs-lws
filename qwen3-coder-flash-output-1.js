client = opts.provider === 'gemini' ? new GeminiClient(opts) : 
         opts.provider === 'openai' ? new OpenAIClient(opts) : 
         new OllamaClient(opts);