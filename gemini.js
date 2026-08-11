fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent', {
  headers: { 'Content-Type': 'application/json', 'X-goog-api-key': process.env.GEMINI_API_KEY },
  method: 'POST',
  body: '{ "contents": [ { "parts": [ { "text":"Explain how AI works in a few words" } ] } ] }',
});

fetch('https://generativelanguage.googleapis.com/v1beta/models?key=' + process.env.GEMINI_API_KEY);
