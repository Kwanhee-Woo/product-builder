require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const genAI  = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

app.use(express.json());
app.use(express.static(path.join(__dirname)));

/* ── System prompts ── */
const CHAT_SYSTEM = `당신은 대한민국 건강보험 심사청구 전문 AI 어시스턴트입니다.
건강보험심사평가원(심평원) 기준, 요양급여 기준, 청구 방법, KCD 상병코드,
행위수가코드, 약제코드, 이의신청, 삭감 예방 등에 대해 전문적으로 안내합니다.
의료기관 실무담당자가 이해하기 쉽도록 구체적이고 실용적으로 답변하세요.
관련 고시·기준이 있으면 언급하고, 답변은 반드시 한국어로 작성하세요.`;

const EDI_SYSTEM = `당신은 대한민국 건강보험 EDI 청구 파일 전문 분석가입니다.
업로드된 EDI 파일을 검토하여 청구 항목의 정확성, 오류 가능성, 심사 유의사항을 진단합니다.
분석 결과는 다음 섹션 순서로 작성하세요:

## 기본 정보
## 상병코드 분석
## 수가·행위코드 분석
## 검토 의견
## 종합 요약

각 섹션에 관련 내용을 구체적으로 작성하고, 주의사항은 ⚠️, 정상 항목은 ✅, 오류는 ❌로 표시하세요.
답변은 한국어로 작성하세요.`;

/* ── Chat (SSE streaming) ── */
app.post('/api/chat', async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message) return res.status(400).json({ error: '메시지가 없습니다.' });

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: CHAT_SYSTEM
    });

    const chat = model.startChat({
      history: history.map(function (h) {
        return { role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content }] };
      })
    });

    const result = await chat.sendMessageStream(message);

    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) res.write(`data: ${JSON.stringify({ text })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
  } finally {
    res.end();
  }
});

/* ── EDI analysis ── */
app.post('/api/analyze-edi', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });

  const filename = req.file.originalname;
  const raw      = req.file.buffer.toString('utf-8');
  const preview  = raw.substring(0, 6000);

  const prompt = `다음은 요양기관이 업로드한 EDI 파일입니다.
파일명: ${filename}
크기: ${(req.file.size / 1024).toFixed(1)} KB

--- EDI 파일 내용 ---
${preview}
--- 끝 ---

위 파일을 전문적으로 분석해 주세요.`;

  try {
    const model  = genAI.getGenerativeModel({ model: 'gemini-2.5-flash', systemInstruction: EDI_SYSTEM });
    const result = await model.generateContent(prompt);
    res.json({ analysis: result.response.text() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`심사청구 AI 서버 실행 중 → http://localhost:${PORT}/claims-assistant.html`);
  if (!process.env.GEMINI_API_KEY) console.warn('⚠️  GEMINI_API_KEY 환경변수가 설정되지 않았습니다.');
});
