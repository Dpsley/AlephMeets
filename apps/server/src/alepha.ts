import axios from 'axios'
import FormData from 'form-data'
import { config } from './config.js'

type NewChatResponse = {
  dialog_id?: string
}

async function postAgentForm<T>(path: string, fields: Record<string, string>): Promise<T> {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.append(key, value)
  const response = await axios.post(`${config.alephaAgentBaseUrl}${path}`, form, {
    headers: form.getHeaders(),
    responseType: 'text',
    timeout: 180_000,
    transformResponse: [(data) => data],
  })
  const raw = typeof response.data === 'string' ? response.data : String(response.data ?? '')
  try {
    return JSON.parse(raw) as T
  } catch {
    return raw as T
  }
}

function extractAgentText(raw: string): string {
  const dataLines = raw.split(/\r?\n/).filter((line) => line.startsWith('data:'))
  if (!dataLines.length) return raw.trim()

  let output = ''
  for (const line of dataLines) {
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') continue
    try {
      const event = JSON.parse(data) as Record<string, unknown>
      if (event.type === 'text.delta' && typeof event.delta === 'string') output += event.delta
      if (event.type === 'runtime.error') {
        throw Object.assign(new Error(typeof event.message === 'string' ? event.message : 'Alepha generation failed'), {
          statusCode: 502,
        })
      }
    } catch (error) {
      if (error instanceof Error && 'statusCode' in error) throw error
    }
  }
  return output.trim()
}

export async function createAlephaMeetingReply(input: {
  meetingId: string
  transcriptText: string
  context: string
}): Promise<string> {
  const created = await postAgentForm<NewChatResponse>('/new_chat', {
    source_name: 'alephmeets',
    chat_id: input.meetingId,
    dialog_type: 'general',
  })
  const dialogId = created.dialog_id
  if (!dialogId) throw Object.assign(new Error('Alepha did not return dialog_id'), { statusCode: 502 })

  const prompt = [
    'Ты голосовой AI-участник встречи. Отвечай по-русски, кратко и естественно, как в разговоре.',
    'Отвечай на последнюю реплику участника. Если вопрос требует уточнения, задай один короткий вопрос.',
    input.context.trim() ? `Последние реплики встречи:\n${input.context.slice(-12_000)}` : '',
    `Последняя реплика участника:\n${input.transcriptText.trim()}`,
  ].filter(Boolean).join('\n\n')
  const raw = await postAgentForm<string>('/chat_stream', {
    text: prompt,
    chat_id: dialogId,
    dialog_type: 'general',
    without_old: 'True',
    source_name: 'alephmeets',
    model_id: 'alepha',
  })
  const text = extractAgentText(raw)
  if (!text) throw Object.assign(new Error('Alepha returned an empty meeting reply'), { statusCode: 502 })
  return text
}

export async function synthesizeAlephaSpeech(text: string): Promise<Buffer> {
  if (!config.ttsApiKey) {
    throw Object.assign(new Error('TTS_API_KEY is not configured on the AlephMeets server'), { statusCode: 503 })
  }
  try {
    const response = await axios.post<ArrayBuffer>(`${config.ttsBaseUrl}/audio/speech`, {
      model: config.ttsModelId,
      voice: config.ttsVoice,
      input: text,
      response_format: 'wav',
      language: config.ttsLanguage,
    }, {
      headers: { Authorization: `Bearer ${config.ttsApiKey}` },
      responseType: 'arraybuffer',
      timeout: 300_000,
    })
    return Buffer.from(response.data)
  } catch (error) {
    if (error && typeof error === 'object' && 'statusCode' in error) throw error
    throw Object.assign(new Error('TTS synthesis failed'), { statusCode: 502 })
  }
}

export async function createAlephaConspect(input: {
  chatId: string
  transcriptText: string
}): Promise<{ dialogId: string; text: string }> {
  const created = await postAgentForm<NewChatResponse>('/new_chat', {
    source_name: 'alephmeets',
    chat_id: input.chatId,
    dialog_type: 'conspect',
  })
  const dialogId = created.dialog_id
  if (!dialogId) throw Object.assign(new Error('Alepha did not return dialog_id'), { statusCode: 502 })

  const text = await postAgentForm<string>('/chat_stream', {
    text: input.transcriptText,
    chat_id: dialogId,
    dialog_type: 'conspect',
    without_old: 'True',
    source_name: 'alephmeets',
    model_id: 'alepha',
  })
  const trimmed = text.trim()
  if (!trimmed) throw Object.assign(new Error('Alepha returned an empty conspect'), { statusCode: 502 })
  return { dialogId, text: trimmed }
}
