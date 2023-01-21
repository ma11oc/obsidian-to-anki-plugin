/* Manages parsing notes into a dictionary formatted for AnkiConnect.

Input must be the note text.
Does NOT deal with finding the note in the file. */

import { FormatConverter } from './format'
import { AnkiConnectNote, AnkiConnectNoteAndID } from './interfaces/note-interface'
import { FIELDS_DICT, FROZEN_FIELDS_DICT } from './interfaces/field-interface'
import { FileData } from './interfaces/settings-interface'

const TAG_PREFIX:string = 'Tags: '
export const TAG_SEP:string = ' '
export const ID_REGEXP_STR: string = String.raw`\n?(?:<!--)?(?:ID: (\d+).*)`
export const TAG_REGEXP_STR: string = String.raw`(Tags: .*)`
const OBS_TAG_REGEXP: RegExp = /#(\w+)/g

const ANKI_CLOZE_REGEXP: RegExp = /{{c\d+::[\s\S]+?}}/
export const CLOZE_ERROR: number = 42
export const NOTE_TYPE_ERROR: number = 69

function has_clozes (text: string): boolean {
  /* Checks whether text actually has cloze deletions. */
  return ANKI_CLOZE_REGEXP.test(text)
}

function note_has_clozes (note: AnkiConnectNote): boolean {
  /* Checks whether a note has cloze deletions in any of its fields. */
  for (const i in note.fields) {
    if (has_clozes(note.fields[i])) {
      return true
    }
  }
  return false
}

function removeTags (text: string): string {
  return text.replaceAll(/(#[^\s]*)/gm, '')
}

function removeBlockquotes (text: string): string {
  return text.replaceAll(/^>\s?/gm, '')
}

abstract class AbstractNote {
  text: string
  split_text: string[]
  current_field_num: number
  delete: boolean
  identifier: number | null
  tags: string[]
  note_type: string
  field_names: string[]
  current_field: string
  ID_REGEXP: RegExp = /(?:<!--)?ID: (\d+)/
  formatter: FormatConverter
  curly_cloze: boolean
  highlights_to_cloze: boolean
  no_note_type: boolean

  constructor (note_text: string, fields_dict: FIELDS_DICT, curly_cloze: boolean, highlights_to_cloze: boolean, formatter: FormatConverter) {
    this.text = note_text.trim()
    this.current_field_num = 0
    this.delete = false
    this.no_note_type = false
    this.split_text = this.getSplitText()
    this.identifier = this.getIdentifier()
    this.tags = this.getTags()
    this.note_type = this.getNoteType()
    if (!(fields_dict.hasOwnProperty(this.note_type))) {
      this.no_note_type = true
      return
    }
    this.field_names = fields_dict[this.note_type]
    this.current_field = this.field_names[0]
    this.formatter = formatter
    this.curly_cloze = curly_cloze
    this.highlights_to_cloze = highlights_to_cloze
  }

    abstract getSplitText(): string[]

    abstract getIdentifier(): number | null

    abstract getTags(): string[]

    abstract getNoteType(): string

    abstract getFields(): Record<string, string>

    parse (deck:string, url:string, frozenFieldsDict: FROZEN_FIELDS_DICT, data: FileData, context:string): AnkiConnectNoteAndID {
      const template = JSON.parse(JSON.stringify(data.template))
      template.modelName = this.note_type
      if (this.no_note_type) {
        return { note: template, identifier: NOTE_TYPE_ERROR }
      }
      template.fields = this.getFields()
      const fileLinkFields = data.file_link_fields
      if (url) {
        this.formatter.format_note_with_url(template, url, fileLinkFields[this.note_type])
      }
      if (Object.keys(frozenFieldsDict).length) {
        this.formatter.format_note_with_frozen_fields(template, frozenFieldsDict)
      }
      if (context) {
        const contextField = data.context_fields[this.note_type]
        template.fields[contextField] += context
      }
      if (data.add_obs_tags) {
        for (const key in template.fields) {
          for (const match of template.fields[key].matchAll(OBS_TAG_REGEXP)) {
            this.tags.push(match[1])
          }
          template.fields[key] = template.fields[key].replace(OBS_TAG_REGEXP, '')
        }
      }
      template.tags.push(...this.tags)
      template.deckName = deck
      return { note: template, identifier: this.identifier }
    }
}

export class Note extends AbstractNote {
  getSplitText (): string[] {
    return this.text.split('\n')
  }

  getIdentifier (): number | null {
    if (this.ID_REGEXP.test(this.split_text[this.split_text.length - 1])) {
      return parseInt(this.ID_REGEXP.exec(this.split_text.pop())[1])
    } else {
      return null
    }
  }

  getTags (): string[] {
    if (this.split_text[this.split_text.length - 1].startsWith(TAG_PREFIX)) {
      return this.split_text.pop().slice(TAG_PREFIX.length).split(TAG_SEP)
    } else {
      return []
    }
  }

  getNoteType (): string {
    return this.split_text[0]
  }

  fieldFromLine (line: string): [string, string] {
    /* From a given line, determine the next field to add text into.

        Then, return the stripped line, and the field. */
    for (const field of this.field_names) {
      if (line.startsWith(field + ':')) {
        return [line.slice((field + ':').length), field]
      }
    }
    return [line, this.current_field]
  }

  getFields (): Record<string, string> {
    const fields: Record<string, string> = {}
    for (const field of this.field_names) {
      fields[field] = ''
    }
    for (let line of this.split_text.slice(1)) {
      [line, this.current_field] = this.fieldFromLine(line)
      fields[this.current_field] += line + '\n'
    }
    for (const key in fields) {
      fields[key] = this.formatter.format(
        fields[key].trim(),
        this.note_type.toLowerCase().includes('cloze') && this.curly_cloze,
        this.highlights_to_cloze
      ).trim()
    }
    return fields
  }
}

export class InlineNote extends AbstractNote {
  static TAG_REGEXP: RegExp = /Tags: (.*)/
  static ID_REGEXP: RegExp = /(?:<!--)?ID: (\d+)/
  static TYPE_REGEXP: RegExp = /\[(.*?)\]/

  getSplitText (): string[] {
    return this.text.split(' ')
  }

  getIdentifier (): number | null {
    const result = this.text.match(InlineNote.ID_REGEXP)
    if (result) {
      this.text = this.text.slice(0, result.index).trim()
      return parseInt(result[1])
    } else {
      return null
    }
  }

  getTags (): string[] {
    const result = this.text.match(InlineNote.TAG_REGEXP)
    if (result) {
      this.text = this.text.slice(0, result.index).trim()
      return result[1].split(TAG_SEP)
    } else {
      return []
    }
  }

  getNoteType (): string {
    const result = this.text.match(InlineNote.TYPE_REGEXP)
    this.text = this.text.slice(result.index + result[0].length)
    return result[1]
  }

  getFields (): Record<string, string> {
    const fields: Record<string, string> = {}
    for (const field of this.field_names) {
      fields[field] = ''
    }
    for (let word of this.text.split(' ')) {
      for (const field of this.field_names) {
        if (word === field + ':') {
          this.current_field = field
          word = ''
        }
      }
      fields[this.current_field] += word + ' '
    }
    for (const key in fields) {
      fields[key] = this.formatter.format(
        fields[key].trim(),
        this.note_type.toLowerCase().includes('cloze') && this.curly_cloze,
        this.highlights_to_cloze
      ).trim()
    }
    return fields
  }
}

export class RegexNote {
  match: RegExpMatchArray
  note_type: string
  groups: Array<string>
  identifier: number | null
  tags: string[]
  field_names: string[]
  curly_cloze: boolean
  highlights_to_cloze: boolean
  formatter: FormatConverter

  constructor (
    match: RegExpMatchArray,
    note_type: string,
    fields_dict: FIELDS_DICT,
    tags: boolean,
    id: boolean,
    curly_cloze: boolean,
    highlights_to_cloze: boolean,
    formatter: FormatConverter
  ) {
    this.match = match
    this.note_type = note_type
    this.identifier = id ? parseInt(this.match.pop()) : null
    this.tags = tags ? this.match.pop().slice(TAG_PREFIX.length).split(TAG_SEP) : []
    this.field_names = fields_dict[note_type]
    this.curly_cloze = curly_cloze
    this.formatter = formatter
    this.highlights_to_cloze = highlights_to_cloze
  }

  getFields (): Record<string, string> {
    const fields: Record<string, string> = {}
    for (const field of this.field_names) {
      fields[field] = ''
    }
    for (const index in this.match.slice(1)) {
      fields[this.field_names[index]] = this.match.slice(1)[index] ? this.match.slice(1)[index] : ''
    }
    for (const key in fields) {
      fields[key] = this.formatter.format(
        fields[key].trim(),
        this.note_type.toLowerCase().includes('cloze') && this.curly_cloze,
        this.highlights_to_cloze
      ).trim()
    }
    return fields
  }

  parse (deck: string, url: string = '', frozenFieldsDict: FROZEN_FIELDS_DICT, data: FileData, context: string): AnkiConnectNoteAndID {
    const template = JSON.parse(JSON.stringify(data.template))
    template.modelName = this.note_type
    template.fields = this.getFields()
    const fileLinkFields = data.file_link_fields
    if (url) {
      this.formatter.format_note_with_url(template, url, fileLinkFields[this.note_type])
    }
    if (Object.keys(frozenFieldsDict).length) {
      this.formatter.format_note_with_frozen_fields(template, frozenFieldsDict)
    }
    if (context) {
      const contextField = data.context_fields[this.note_type]
      template.fields[contextField] += context
    }
    if (this.note_type.toLowerCase().includes('cloze') && !(note_has_clozes(template))) {
      this.identifier = CLOZE_ERROR // An error code that says "don't add this note!"
    }
    template.tags.push(...this.tags)
    template.deckName = deck
    return { note: template, identifier: this.identifier }
  }
}

export class CalloutNote extends AbstractNote {
  static TAG_REGEXP: RegExp = /#([^\s]*)/gm
  static ID_REGEXP: RegExp = /(?:<!--)?ID: (\d+)/
  static TYPE_REGEXP: RegExp = /\[!anki[:]?(.*)?\](?:.*)/

  getSplitText (): string[] {
    return this.text.split(' ')
  }

  getIdentifier (): number | null {
    const result = this.text.match(CalloutNote.ID_REGEXP)
    if (result) {
      this.text = this.text.slice(0, result.index).trim()
      return parseInt(result[1])
    } else {
      return null
    }
  }

  getTags (): string[] {
    const result = this.text.matchAll(CalloutNote.TAG_REGEXP)
    if (result) {
      return [...result].map(el => el[1])
    } else {
      return []
    }
  }

  getNoteType (): string {
    const result = this.text.match(CalloutNote.TYPE_REGEXP)
    if (result) {
      return result[1]
    } else {
      return null
    }
  }

  getFields (): Record<string, string> {
    const match = this.text.match(/^> \[!anki[:]?(?:.*)?\](?:-*\s*)?([^\n]*)\n([\S\s]*)/)
    const fields: Record<string, string> = {}
    for (const field of this.field_names) {
      fields[field] = ''
    }

    const front = removeTags(match[1])
    const back = removeBlockquotes(match[2])

    if (!front || !back) {
      console.error('Front or Back field is empty. Skipping the note.')
      return {}
    }

    fields.Front = front
    fields.Back = back

    for (const key in fields) {
      fields[key] = this.formatter.format(
        fields[key].trim(),
        this.curly_cloze,
        this.highlights_to_cloze
      ).trim()
    }
    return fields
  }
}
