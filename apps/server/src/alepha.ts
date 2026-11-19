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
