// Options shown in the UI. Kept on the server so the browser never needs to know Sarvam details.
const languages = [
  { code: 'hi-IN', name: 'Hindi', sample: 'नमस्ते! आज मैं आपकी किस तरह मदद करूँ?' },
  { code: 'en-IN', name: 'English (India)', sample: 'Hello! This is a quick call to help you with your request.' },
  { code: 'bn-IN', name: 'Bengali', sample: 'নমস্কার! আমি আপনাকে কীভাবে সাহায্য করতে পারি?' },
  { code: 'gu-IN', name: 'Gujarati', sample: 'નમસ્તે! હું તમારી કેવી રીતે મદદ કરી શકું?' },
  { code: 'kn-IN', name: 'Kannada', sample: 'ನಮಸ್ಕಾರ! ನಾನು ನಿಮಗೆ ಹೇಗೆ ಸಹಾಯ ಮಾಡಬಹುದು?' },
  { code: 'ml-IN', name: 'Malayalam', sample: 'നമസ്കാരം! ഞാൻ നിങ്ങളെ എങ്ങനെ സഹായിക്കും?' },
  { code: 'mr-IN', name: 'Marathi', sample: 'नमस्कार! मी तुम्हाला कशी मदत करू?' },
  { code: 'od-IN', name: 'Odia', sample: 'ନମସ୍କାର! ମୁଁ ଆପଣଙ୍କୁ କିପରି ସାହାଯ୍ୟ କରିପାରିବି?' },
  { code: 'pa-IN', name: 'Punjabi', sample: 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ! ਦੱਸੋ, ਤੁਹਾਡੀ ਕੀ ਮਦਦ ਕਰਾਂ?' },
  { code: 'ta-IN', name: 'Tamil', sample: 'வணக்கம்! நான் உங்களுக்கு எப்படி உதவ முடியும்?' },
  { code: 'te-IN', name: 'Telugu', sample: 'నమస్కారం! నేను మీకు ఎలా సహాయం చేయగలను?' },
];

const ttsModels = [
  {
    id: 'bulbul:v3',
    label: 'Bulbul v3',
    note: 'Natural, expressive voices. Good default.',
    pace: [0.5, 2],
    speakers: ['shubh', 'aditya', 'ritu', 'priya', 'neha', 'rahul', 'pooja', 'rohan', 'simran', 'kavya',
      'amit', 'dev', 'ishita', 'shreya', 'ratan', 'varun', 'manan', 'sumit', 'roopa', 'kabir', 'aayan',
      'ashutosh', 'advait', 'anand', 'tanya', 'tarun', 'sunny', 'mani', 'gokul', 'vijay', 'shruti',
      'suhani', 'mohit', 'kavitha', 'rehan', 'soham', 'rupali'],
  },
  {
    id: 'bulbul:v4-flash',
    label: 'Bulbul v4 Flash',
    note: 'Newest, fastest. 200+ personas named like shubh_hi_devotional. Type a persona ID from the Sarvam voices guide.',
    pace: [0.5, 2],
    speakers: null,
    defaultSpeaker: 'shubh_enhi_ads',
  },
];

// sarvam-30b and sarvam-m are deprecated by Sarvam; bulbul:v2 too.
const llmModels = [
  { id: 'sarvam-105b-conversations', label: 'Sarvam 105B Conversations', note: 'Tuned for dialogue, fast. Recommended for calls.' },
  { id: 'sarvam-105b', label: 'Sarvam 105B', note: 'Most capable, 128K context.' },
];
const DEFAULT_LLM = llmModels[0].id;

const reasoningLevels = [
  { id: '', label: 'Model default' },
  { id: 'low', label: 'Low (fastest replies)' },
  { id: 'high', label: 'High' },
];

const outcomes = ['interested', 'not_interested', 'callback_requested', 'converted', 'wrong_number', 'no_response', 'incomplete', 'other'];

const languageName = (code) => (languages.find((l) => l.code === code) || {}).name || code;

module.exports = { languages, ttsModels, llmModels, DEFAULT_LLM, reasoningLevels, outcomes, languageName };
