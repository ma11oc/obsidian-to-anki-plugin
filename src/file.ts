/* Performing plugin operations on markdown file contents */

import { FROZEN_FIELDS_DICT } from './interfaces/field-interface'
import { AnkiConnectNote, AnkiConnectNoteAndID } from './interfaces/note-interface'
import { FileData } from './interfaces/settings-interface'
import { Note, InlineNote, RegexNote, CalloutNote, CLOZE_ERROR, NOTE_TYPE_ERROR, TAG_SEP, ID_REGEXP_STR, TAG_REGEXP_STR } from './note'
import { Md5 } from 'ts-md5/dist/md5'
import * as AnkiConnect from './anki'
import * as c from './constants'
import { FormatConverter } from './format'
import { CachedMetadata, HeadingCache } from 'obsidian'

const double_regexp: RegExp = /(?:\r\n|\r|\n)((?:\r\n|\r|\n)(?:<!--)?ID: \d+)/g

function id_to_str (identifier:number, inline:boolean = false, comment:boolean = false): string {
  let result = 'ID: ' + identifier.toString()
  if (comment) {
    result = '<!--' + result + '-->'
  }
  if (inline) {
    result += ' '
  } else {
    result += '\n'
  }
  return result
}

function string_insert (text: string, position_inserts: Array<[number, string]>): string {
  /* Insert strings in position_inserts into text, at indices.

    position_inserts will look like:
    [(0, "hi"), (3, "hello"), (5, "beep")] */
  let offset = 0
  const sorted_inserts: Array<[number, string]> = position_inserts.sort((a, b):number => a[0] - b[0])
  for (const insertion of sorted_inserts) {
    const position = insertion[0]
    const insert_str = insertion[1]
    text = text.slice(0, position + offset) + insert_str + text.slice(position + offset)
    offset += insert_str.length
  }
  return text
}

function spans (pattern: RegExp, text: string): Array<[number, number]> {
  /* Return a list of span-tuples for matches of pattern in text. */
  const output: Array<[number, number]> = []
  const matches = text.matchAll(pattern)
  for (const match of matches) {
    output.push(
      [match.index, match.index + match[0].length]
    )
  }
  return output
}

function contained_in (span: [number, number], spans: Array<[number, number]>): boolean {
  /* Return whether span is contained in spans (+- 1 leeway) */
  return spans.some(
    (element) => span[0] >= element[0] - 1 && span[1] <= element[1] + 1
  )
}

function * findignore (pattern: RegExp, text: string, ignore_spans: Array<[number, number]>): IterableIterator<RegExpMatchArray> {
  const matches = text.matchAll(pattern)
  for (const match of matches) {
    if (!(contained_in([match.index, match.index + match[0].length], ignore_spans))) {
      yield match
    }
  }
}

abstract class AbstractFile {
  file: string
  path: string
  url: string
  original_file: string
  data: FileData
  file_cache: CachedMetadata

  frozen_fields_dict: FROZEN_FIELDS_DICT
  target_deck: string
  global_tags: string

  notes_to_add: AnkiConnectNote[]
  id_indexes: number[]
  notes_to_edit: AnkiConnectNoteAndID[]
  notes_to_delete: number[]
  all_notes_to_add: AnkiConnectNote[]

  note_ids: Array<number | null>
  card_ids: number[]
  tags: string[]

  formatter: FormatConverter

  constructor (file_contents: string, path:string, url: string, data: FileData, file_cache: CachedMetadata) {
    this.data = data
    this.file = file_contents
    this.path = path
    this.url = url
    this.original_file = this.file
    this.file_cache = file_cache
    this.formatter = new FormatConverter(file_cache, this.data.vault_name)
  }

  setup_frozen_fields_dict () {
    const frozen_fields_dict: FROZEN_FIELDS_DICT = {}
    for (const note_type in this.data.fields_dict) {
      const fields: string[] = this.data.fields_dict[note_type]
      const temp_dict: Record<string, string> = {}
      for (const field of fields) {
        temp_dict[field] = ''
      }
      frozen_fields_dict[note_type] = temp_dict
    }
    for (const match of this.file.matchAll(this.data.FROZEN_REGEXP)) {
      const [note_type, fields]: [string, string] = [match[1], match[2]]
      const virtual_note = note_type + '\n' + fields
      const parsed_fields: Record<string, string> = new Note(
        virtual_note,
        this.data.fields_dict,
        this.data.curly_cloze,
        this.data.highlights_to_cloze,
        this.formatter
      ).getFields()
      frozen_fields_dict[note_type] = parsed_fields
    }
    this.frozen_fields_dict = frozen_fields_dict
  }

  setup_target_deck () {
    const result = this.file.match(this.data.DECK_REGEXP)
    this.target_deck = result ? result[1] : this.data.template.deckName
  }

  setup_global_tags () {
    const result = this.file.match(this.data.TAG_REGEXP)
    this.global_tags = result ? result[1] : ''
  }

  getHash (): string {
    return Md5.hashStr(this.file) as string
  }

    abstract scanFile(): void

    scanDeletions () {
      for (const match of this.file.matchAll(this.data.EMPTY_REGEXP)) {
        this.notes_to_delete.push(parseInt(match[1]))
      }
    }

    getContextAtIndex (position: number): string {
      const result: string = this.path
      let currentContext: HeadingCache[] = []
      if (!(this.file_cache.hasOwnProperty('headings'))) {
        return result
      }
      for (const currentHeading of this.file_cache.headings) {
        if (position < currentHeading.position.start.offset) {
          // We've gone past position now with headings, so let's return!
          break
        }
        let insert_index: number = 0
        for (const contextHeading of currentContext) {
          if (currentHeading.level > contextHeading.level) {
            insert_index += 1
            continue
          }
          break
        }
        currentContext = currentContext.slice(0, insert_index)
        currentContext.push(currentHeading)
      }
      const heading_strs: string[] = []
      for (const contextHeading of currentContext) {
        heading_strs.push(contextHeading.heading)
      }
      const result_arr: string[] = [result]
      result_arr.push(...heading_strs)
      return result_arr.join(' > ')
    }

    abstract writeIDs(): void

    removeEmpties () {
      this.file = this.file.replace(this.data.EMPTY_REGEXP, '')
    }

    getAddNotes (): AnkiConnect.AnkiConnectRequest {
      const actions: AnkiConnect.AnkiConnectRequest[] = []
      for (const note of this.all_notes_to_add) {
        actions.push(AnkiConnect.addNote(note))
      }
      return AnkiConnect.multi(actions)
    }

    getDeleteNotes (): AnkiConnect.AnkiConnectRequest {
      return AnkiConnect.deleteNotes(this.notes_to_delete)
    }

    getUpdateFields (): AnkiConnect.AnkiConnectRequest {
      const actions: AnkiConnect.AnkiConnectRequest[] = []
      for (const parsed of this.notes_to_edit) {
        actions.push(
          AnkiConnect.updateNoteFields(
            parsed.identifier, parsed.note.fields
          )
        )
      }
      return AnkiConnect.multi(actions)
    }

    getNoteInfo (): AnkiConnect.AnkiConnectRequest {
      const IDs: number[] = []
      for (const parsed of this.notes_to_edit) {
        IDs.push(parsed.identifier)
      }
      return AnkiConnect.notesInfo(IDs)
    }

    getChangeDecks (): AnkiConnect.AnkiConnectRequest {
      return AnkiConnect.changeDeck(this.card_ids, this.target_deck)
    }

    getClearTags (): AnkiConnect.AnkiConnectRequest {
      const IDs: number[] = []
      for (const parsed of this.notes_to_edit) {
        IDs.push(parsed.identifier)
      }
      return AnkiConnect.removeTags(IDs, this.tags.join(' '))
    }

    getAddTags (): AnkiConnect.AnkiConnectRequest {
      const actions: AnkiConnect.AnkiConnectRequest[] = []
      for (const parsed of this.notes_to_edit) {
        actions.push(
          AnkiConnect.addTags([parsed.identifier], parsed.note.tags.join(' ') + ' ' + this.global_tags)
        )
      }
      return AnkiConnect.multi(actions)
    }
}

export class AllFile extends AbstractFile {
  ignore_spans: [number, number][]
  custom_regexps: Record<string, string>
  inline_notes_to_add: AnkiConnectNote[]
  inline_id_indexes: number[]
  regex_notes_to_add: AnkiConnectNote[]
  regex_id_indexes: number[]
  callout_notes_to_add: AnkiConnectNote[]
  callout_id_indexes: number[]

  constructor (fileContents: string, path:string, url: string, data: FileData, fileCache: CachedMetadata) {
    super(fileContents, path, url, data, fileCache)
    this.custom_regexps = data.custom_regexps
  }

  add_spans_to_ignore () {
    this.ignore_spans = []
    this.ignore_spans.push(...spans(this.data.FROZEN_REGEXP, this.file))
    const deckResult = this.file.match(this.data.DECK_REGEXP)
    if (deckResult) {
      this.ignore_spans.push([deckResult.index, deckResult.index + deckResult[0].length])
    }
    const tagResult = this.file.match(this.data.TAG_REGEXP)
    if (tagResult) {
      this.ignore_spans.push([tagResult.index, tagResult.index + tagResult[0].length])
    }
    this.ignore_spans.push(...spans(this.data.NOTE_REGEXP, this.file))
    this.ignore_spans.push(...spans(this.data.INLINE_REGEXP, this.file))
    this.ignore_spans.push(...spans(c.OBS_INLINE_MATH_REGEXP, this.file))
    this.ignore_spans.push(...spans(c.OBS_DISPLAY_MATH_REGEXP, this.file))
    this.ignore_spans.push(...spans(c.OBS_CODE_REGEXP, this.file))
    this.ignore_spans.push(...spans(c.OBS_DISPLAY_CODE_REGEXP, this.file))
  }

  setupScan () {
    this.setup_frozen_fields_dict()
    this.setup_target_deck()
    this.setup_global_tags()
    this.add_spans_to_ignore()
    this.notes_to_add = []
    this.inline_notes_to_add = []
    this.callout_notes_to_add = []
    this.regex_notes_to_add = []
    this.id_indexes = []
    this.inline_id_indexes = []
    this.regex_id_indexes = []
    this.callout_id_indexes = []
    this.notes_to_edit = []
    this.notes_to_delete = []
  }

  scanNotes () {
    for (const noteMatch of this.file.matchAll(this.data.NOTE_REGEXP)) {
      const [note, position]: [string, number] = [noteMatch[1], noteMatch.index + noteMatch[0].indexOf(noteMatch[1]) + noteMatch[1].length]
      // That second thing essentially gets the index of the end of the first capture group.
      const parsed = new Note(
        note,
        this.data.fields_dict,
        this.data.curly_cloze,
        this.data.highlights_to_cloze,
        this.formatter
      ).parse(
        this.target_deck,
        this.url,
        this.frozen_fields_dict,
        this.data,
        this.data.add_context ? this.getContextAtIndex(noteMatch.index) : ''
      )
      if (parsed.identifier == null) {
        // Need to make sure global_tags get added
        parsed.note.tags.push(...this.global_tags.split(TAG_SEP))
        this.notes_to_add.push(parsed.note)
        this.id_indexes.push(position)
      } else if (!this.data.EXISTING_IDS.includes(parsed.identifier)) {
        if (parsed.identifier === CLOZE_ERROR) {
          continue
        } else if (parsed.identifier === NOTE_TYPE_ERROR) {
          // Need to show an error otherwise
          console.warn('Did not recognise note type ', parsed.note.modelName, ' in file ', this.path)
        } else {
          console.warn('Note with id', parsed.identifier, ' in file ', this.path, ' does not exist in Anki!')
        }
      } else {
        this.notes_to_edit.push(parsed)
      }
    }
  }

  scanInlineNotes () {
    for (const noteMatch of this.file.matchAll(this.data.INLINE_REGEXP)) {
      const [note, position]: [string, number] = [noteMatch[1], noteMatch.index + noteMatch[0].indexOf(noteMatch[1]) + noteMatch[1].length]
      // That second thing essentially gets the index of the end of the first capture group.
      const parsed = new InlineNote(
        note,
        this.data.fields_dict,
        this.data.curly_cloze,
        this.data.highlights_to_cloze,
        this.formatter
      ).parse(
        this.target_deck,
        this.url,
        this.frozen_fields_dict,
        this.data,
        this.data.add_context ? this.getContextAtIndex(noteMatch.index) : ''
      )
      if (parsed.identifier == null) {
        // Need to make sure global_tags get added
        parsed.note.tags.push(...this.global_tags.split(TAG_SEP))
        this.inline_notes_to_add.push(parsed.note)
        this.inline_id_indexes.push(position)
      } else if (!this.data.EXISTING_IDS.includes(parsed.identifier)) {
        // Need to show an error
        if (parsed.identifier === CLOZE_ERROR) {
          continue
        }
        console.warn('Note with id', parsed.identifier, ' in file ', this.path, ' does not exist in Anki!')
      } else {
        this.notes_to_edit.push(parsed)
      }
    }
  }

  scanCalloutNotes () {
    console.log('Scanning the file for CalloutNotes')
    for (const noteMatch of this.file.matchAll(this.data.CALLOUT_REGEXP)) {
      const [note, position]: [string, number] = [noteMatch[1], noteMatch.index + noteMatch[0].indexOf(noteMatch[1]) + noteMatch[1].length]
      // That second thing essentially gets the index of the end of the first capture group.
      const parsed = new CalloutNote(
        note,
        this.data.fields_dict,
        this.data.curly_cloze,
        this.data.highlights_to_cloze,
        this.formatter
      ).parse(
        this.target_deck,
        this.url,
        this.frozen_fields_dict,
        this.data,
        this.data.add_context ? this.getContextAtIndex(noteMatch.index) : ''
      )
      if (parsed.identifier == null) {
        // Need to make sure global_tags get added
        parsed.note.tags.push(...this.global_tags.split(TAG_SEP))
        this.callout_notes_to_add.push(parsed.note)
        this.callout_id_indexes.push(position)
      } else if (!this.data.EXISTING_IDS.includes(parsed.identifier)) {
        if (parsed.identifier === CLOZE_ERROR) {
          continue
        } else if (parsed.identifier === NOTE_TYPE_ERROR) {
          // Need to show an error otherwise
          console.warn('Did not recognise note type ', parsed.note.modelName, ' in file ', this.path)
        } else {
          console.warn('Note with id', parsed.identifier, ' in file ', this.path, ' does not exist in Anki!')
        }
      } else {
        this.notes_to_edit.push(parsed)
      }
    }
  }

  search (noteType: string, regexpStr: string) {
    // Search the file for regex matches
    // ignoring matches inside ignore_spans,
    // and adding any matches to ignore_spans.
    for (const searchId of [true, false]) {
      for (const searchTags of [true, false]) {
        const idStr = searchId ? ID_REGEXP_STR : ''
        const tagStr = searchTags ? TAG_REGEXP_STR : ''
        const regexp: RegExp = new RegExp(regexpStr + tagStr + idStr, 'gm')
        for (const match of findignore(regexp, this.file, this.ignore_spans)) {
          this.ignore_spans.push([match.index, match.index + match[0].length])
          const parsed: AnkiConnectNoteAndID = new RegexNote(
            match, noteType, this.data.fields_dict,
            searchTags, searchId, this.data.curly_cloze, this.data.highlights_to_cloze, this.formatter
          ).parse(
            this.target_deck,
            this.url,
            this.frozen_fields_dict,
            this.data,
            this.data.add_context ? this.getContextAtIndex(match.index) : ''
          )
          if (searchId) {
            if (!(this.data.EXISTING_IDS.includes(parsed.identifier))) {
              if (parsed.identifier === CLOZE_ERROR) {
                // This means it wasn't actually a note! So we should remove it from ignore_spans
                this.ignore_spans.pop()
                continue
              }
              console.warn('Note with id', parsed.identifier, ' in file ', this.path, ' does not exist in Anki!')
            } else {
              this.notes_to_edit.push(parsed)
            }
          } else {
            if (parsed.identifier === CLOZE_ERROR) {
              // This means it wasn't actually a note! So we should remove it from ignore_spans
              this.ignore_spans.pop()
              continue
            }
            parsed.note.tags.push(...this.global_tags.split(TAG_SEP))
            this.regex_notes_to_add.push(parsed.note)
            this.regex_id_indexes.push(match.index + match[0].length)
          }
        }
      }
    }
  }

  scanFile () {
    this.setupScan()
    this.scanNotes()
    this.scanInlineNotes()
    this.scanCalloutNotes()

    for (const noteType in this.custom_regexps) {
      const regexpStr: string = this.custom_regexps[noteType]
      if (regexpStr) {
        this.search(noteType, regexpStr)
      }
    }

    this.all_notes_to_add = this.notes_to_add.concat(this.inline_notes_to_add).concat(this.regex_notes_to_add).concat(this.callout_notes_to_add)
    this.scanDeletions()
  }

  fix_newline_ids () {
    this.file = this.file.replace(double_regexp, '$1')
  }

  writeIDs () {
    const normalInserts: [number, string][] = []
    this.id_indexes.forEach(
      (idPosition: number, index: number) => {
        const identifier: number | null = this.note_ids[index]
        if (identifier) {
          normalInserts.push([idPosition, id_to_str(identifier, false, this.data.comment)])
        }
      }
    )
    const inlineInserts: [number, string][] = []
    this.inline_id_indexes.forEach(
      (idPosition: number, index: number) => {
        const identifier: number | null = this.note_ids[index + this.notes_to_add.length] // Since regular then inline
        if (identifier) {
          inlineInserts.push([idPosition, id_to_str(identifier, true, this.data.comment)])
        }
      }
    )
    const regexInserts: [number, string][] = []
    this.regex_id_indexes.forEach(
      (idPosition: number, index: number) => {
        const identifier: number | null = this.note_ids[index + this.notes_to_add.length + this.inline_notes_to_add.length] // Since regular then inline then regex
        if (identifier) {
          regexInserts.push([idPosition, '\n' + id_to_str(identifier, false, this.data.comment)])
        }
      }
    )
    const calloutInserts: [number, string][] = []
    this.callout_id_indexes.forEach(
      (idPosition: number, index: number) => {
        const identifier: number | null = this.note_ids[index]
        if (identifier) {
          calloutInserts.push([idPosition, '> ' + id_to_str(identifier, false, this.data.comment)])
        }
      }
    )
    this.file = string_insert(this.file, normalInserts.concat(inlineInserts).concat(regexInserts).concat(calloutInserts))
    this.fix_newline_ids()
  }
}
