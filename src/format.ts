import { AnkiConnectNote } from './interfaces/note-interface'
import { basename, extname } from 'path'
import { Converter, ShowdownExtension } from 'showdown'
import { CachedMetadata } from 'obsidian'
import * as c from './constants'

import showdownHighlight from 'showdown-highlight'

const ANKI_MATH_REGEXP:RegExp = /(\\\[[\s\S]*?\\\])|(\\\([\s\S]*?\\\))/g
const HIGHLIGHT_REGEXP:RegExp = /==(.*?)==/g

const MATH_REPLACE:string = 'OBSTOANKIMATH'
const INLINE_CODE_REPLACE:string = 'OBSTOANKICODEINLINE'
const DISPLAY_CODE_REPLACE:string = 'OBSTOANKICODEDISPLAY'

const CLOZE_REGEXP:RegExp = /(?:(?<!{){(?:c?(\d+)[:|])?(?!{))((?:[^\n][\n]?)+?)(?:(?<!})}(?!}))/g

const IMAGE_EXTS: string[] = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.tiff']
const AUDIO_EXTS: string[] = ['.wav', '.m4a', '.flac', '.mp3', '.wma', '.aac', '.webm']

const PARA_OPEN:string = '<p>'
const PARA_CLOSE:string = '</p>'

let clozeUnsetNum: number = 1

const converter: Converter = new Converter({
  extensions: [showdownHighlight as unknown as ShowdownExtension[]],
  literalMidWordUnderscores: true,
  requireSpaceBeforeHeadingText: true,
  simpleLineBreaks: true,
  simplifiedAutoLink: true,
  tables: true,
  tasklists: true
})

function escapeHtml (unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

export class FormatConverter {
  fileCache: CachedMetadata
  vaultName: string
  detectedMedia: Set<string>

  constructor (fileCache: CachedMetadata, vaultName: string) {
    this.vaultName = vaultName
    this.fileCache = fileCache
    this.detectedMedia = new Set()
  }

  getUrlFromLink (link: string): string {
    return 'obsidian://open?vault=' + encodeURIComponent(this.vaultName) + String.raw`&file=` + encodeURIComponent(link)
  }

  format_note_with_url (note: AnkiConnectNote, url: string, field: string): void {
    note.fields[field] += '<br><a href="' + url + '" class="obsidian-link">Obsidian</a>'
  }

  format_note_with_frozen_fields (note: AnkiConnectNote, frozenFieldsDict: Record<string, Record<string, string>>): void {
    for (const field in note.fields) {
      note.fields[field] += frozenFieldsDict[note.modelName][field]
    }
  }

  obsidian_to_anki_math (noteText: string): string {
    return noteText.replace(
      c.OBS_DISPLAY_MATH_REGEXP, '\\[$1\\]'
    ).replace(
      c.OBS_INLINE_MATH_REGEXP,
      '\\($1\\)'
    )
  }

  cloze_repl (_1: string, matchId: string, matchContent: string): string {
    if (matchId === undefined) {
      const result = '{{c' + clozeUnsetNum.toString() + '::' + matchContent + '}}'
      // clozeUnsetNum += 1 // FIXME: make it flexible
      return result
    }
    const result = '{{c' + matchId + '::' + matchContent + '}}'
    return result
  }

  curly_to_cloze (text: string): string {
    /* Change text in curly brackets to Anki-formatted cloze. */
    text = text.replace(CLOZE_REGEXP, this.cloze_repl)
    clozeUnsetNum = 1
    return text
  }

  getAndFormatMedias (noteText: string): string {
    if (!(this.fileCache.hasOwnProperty('embeds'))) {
      return noteText
    }
    for (const embed of this.fileCache.embeds) {
      if (noteText.includes(embed.original)) {
        this.detectedMedia.add(embed.link)
        if (AUDIO_EXTS.includes(extname(embed.link))) {
          noteText = noteText.replace(new RegExp(c.escapeRegex(embed.original), 'g'), '[sound:' + basename(embed.link) + ']')
        } else if (IMAGE_EXTS.includes(extname(embed.link))) {
          noteText = noteText.replace(
            new RegExp(c.escapeRegex(embed.original), 'g'),
            '<img src="' + basename(embed.link) + '" alt="' + embed.displayText + '">'
          )
        } else {
          console.warn('Unsupported extension: ', extname(embed.link))
        }
      }
    }
    return noteText
  }

  formatLinks (noteText: string): string {
    if (!(this.fileCache.hasOwnProperty('links'))) {
      return noteText
    }
    for (const link of this.fileCache.links) {
      noteText = noteText.replace(new RegExp(c.escapeRegex(link.original), 'g'), '<a href="' + this.getUrlFromLink(link.link) + '">' + link.displayText + '</a>')
    }
    return noteText
  }

  censor (noteText: string, regexp: RegExp, mask: string): [string, string[]] {
    /* Take note_text and replace every match of regexp with mask, simultaneously adding it to a string array */
    const matches: string[] = []
    for (const match of noteText.matchAll(regexp)) {
      matches.push(match[0])
    }
    return [noteText.replace(regexp, mask), matches]
  }

  decensor (noteText: string, mask:string, replacements: string[], escape: boolean): string {
    for (const replacement of replacements) {
      noteText = noteText.replace(
        mask, escape ? escapeHtml(replacement) : replacement
      )
    }
    return noteText
  }

  format (noteText: string, cloze: boolean, highlightToCloze: boolean): string {
    noteText = this.obsidian_to_anki_math(noteText)
    // Extract the parts that are anki math
    let mathMatches: string[]
    let inlineCodeMatches: string[]
    let displayCodeMatches: string[]
    const addHighlightCss: boolean = !!noteText.match(c.OBS_DISPLAY_CODE_REGEXP);
    [noteText, mathMatches] = this.censor(noteText, ANKI_MATH_REGEXP, MATH_REPLACE);
    [noteText, displayCodeMatches] = this.censor(noteText, c.OBS_DISPLAY_CODE_REGEXP, DISPLAY_CODE_REPLACE);
    [noteText, inlineCodeMatches] = this.censor(noteText, c.OBS_CODE_REGEXP, INLINE_CODE_REPLACE)
    if (cloze) {
      if (highlightToCloze) {
        noteText = noteText.replace(HIGHLIGHT_REGEXP, '{$1}')
      }
      noteText = this.curly_to_cloze(noteText)
    }
    noteText = this.getAndFormatMedias(noteText)
    noteText = this.formatLinks(noteText)
    // Special for formatting highlights now, but want to avoid any == in code
    noteText = noteText.replace(HIGHLIGHT_REGEXP, String.raw`<mark>$1</mark>`)
    noteText = this.decensor(noteText, DISPLAY_CODE_REPLACE, displayCodeMatches, false)
    noteText = this.decensor(noteText, INLINE_CODE_REPLACE, inlineCodeMatches, false)
    noteText = converter.makeHtml(noteText)
    noteText = this.decensor(noteText, MATH_REPLACE, mathMatches, true).trim()
    // Remove unnecessary paragraph tag
    if (noteText.startsWith(PARA_OPEN) && noteText.endsWith(PARA_CLOSE)) {
      noteText = noteText.slice(PARA_OPEN.length, -1 * PARA_CLOSE.length)
    }
    if (addHighlightCss) {
      noteText = '<link href="' + c.CODE_CSS_URL + '" rel="stylesheet">' + noteText
    }
    return noteText
  }
}
