import { StreamLanguage, HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

export const klipperLanguage = StreamLanguage.define({
  startState() {
    return { inJinja: null, afterKey: false }
  },
  token(stream, state) {
    if (stream.sol()) state.afterKey = false

    // Inside multi-token Jinja2 block ({% ... %}, {{ ... }}, {# ... #})
    if (state.inJinja) {
      const close = state.inJinja === '{%' ? '%}' : state.inJinja === '{{' ? '}}' : '#}'
      if (stream.match(close)) {
        const prev = state.inJinja
        state.inJinja = null
        return prev === '{#' ? 'comment' : 'meta'
      }
      if (state.inJinja === '{#') {
        stream.next()
        return 'comment'
      }
      if (stream.eatSpace()) return null
      if (stream.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/)) return 'string'
      if (stream.match(/\b(?:if|elif|else|endif|for|endfor|in|set|and|or|not|is|namespace|range|default|float|int|string|round|upper|lower|join|split)\b/)) {
        return 'keyword'
      }
      if (stream.match(/-?\d+(?:\.\d+)?/)) return 'number'
      stream.next()
      return 'variableName'
    }

    if (stream.eatSpace()) return null

    // Full-line or inline comments (# or ;)
    if (stream.peek() === '#' || stream.peek() === ';') {
      stream.skipToEnd()
      return 'comment'
    }

    // Section headers at start of line: [extruder], [gcode_macro ...], [include ...]
    if (stream.sol() && stream.peek() === '[') {
      if (stream.match(/^\[[^\]]+\]/)) return 'heading'
    }

    // Jinja2 opening tags
    if (stream.match('{#')) {
      state.inJinja = '{#'
      return 'comment'
    }
    if (stream.match('{%')) {
      state.inJinja = '{%'
      return 'meta'
    }
    if (stream.match('{{')) {
      state.inJinja = '{{'
      return 'meta'
    }

    // Config key before : or =
    if (!state.afterKey && stream.match(/^[A-Za-z_][A-Za-z0-9_.-]*(?=\s*[:=])/)) {
      state.afterKey = true
      return 'propertyName'
    }

    if (stream.match(/^[:=]/)) {
      state.afterKey = true
      return 'punctuation'
    }

    // Quoted strings
    if (stream.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/)) return 'string'

    // Booleans and Klipper pin modifiers
    if (stream.match(/\b(?:true|false|True|False|TRUE|FALSE)\b/)) return 'atom'
    if (stream.match(/^[!^~]+(?=[A-Za-z0-9_:])/)) return 'atom'

    // Numbers (floats, negatives, hex)
    if (stream.match(/(?:0x[0-9a-fA-F]+|-?\d+(?:\.\d+)?)\b/)) return 'number'

    // G-code words (G0, G28, M109, T0, RESPOND, SAVE_CONFIG)
    if (stream.match(/\b(?:[GM]\d+|T[0-5]|SAVE_CONFIG|RESPOND|SET_GCODE_VARIABLE|SET_HEATER_TEMPERATURE|SET_FAN_SPEED|TEMPERATURE_WAIT)\b/)) {
      return 'keyword'
    }

    stream.next()
    return null
  },
})

const editorBaseTheme = EditorView.theme(
  {
    '&': {
      backgroundColor: 'var(--surface-deep)',
      color: 'var(--text)',
      fontFamily: 'var(--font-mono)',
      fontSize: '12.5px',
    },
    '.cm-content': {
      caretColor: 'var(--lime)',
      padding: '10px 0',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: 'var(--lime)',
      borderLeftWidth: '2px',
    },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'rgba(197, 247, 107, 0.22)',
    },
    '.cm-activeLine': {
      backgroundColor: 'rgba(53, 65, 71, 0.26)',
    },
    '.cm-gutters': {
      backgroundColor: 'var(--surface-subtle)',
      color: '#63757d',
      borderRight: '1px solid var(--line-subtle)',
      fontVariantNumeric: 'tabular-nums',
      userSelect: 'none',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'var(--surface-hover)',
      color: 'var(--text)',
    },
    '.cm-lineNumbers .cm-gutterElement': {
      padding: '0 10px 0 12px',
      minWidth: '42px',
    },
    '.cm-panels': {
      backgroundColor: 'var(--surface)',
      color: 'var(--text)',
      borderColor: 'var(--line)',
    },
    '.cm-panels.cm-panels-top': {
      borderBottom: '1px solid var(--line)',
    },
    '.cm-panels.cm-panels-bottom': {
      borderTop: '1px solid var(--line)',
    },
    '.cm-search': {
      fontFamily: "'Onest', sans-serif",
      fontSize: '12px',
      padding: '8px 12px',
      display: 'flex',
      flexWrap: 'wrap',
      gap: '6px',
      alignItems: 'center',
    },
    '.cm-textfield': {
      backgroundColor: 'var(--surface-deep)',
      color: 'var(--text)',
      border: '1px solid var(--line-strong)',
      borderRadius: '5px',
      padding: '4px 8px',
      minHeight: '30px',
    },
    '.cm-button': {
      backgroundImage: 'none',
      backgroundColor: 'var(--surface-raised)',
      color: 'var(--text)',
      border: '1px solid var(--line-strong)',
      borderRadius: '5px',
      padding: '4px 9px',
      cursor: 'pointer',
    },
    '.cm-button:hover': {
      backgroundColor: '#303e45',
    },
    '.cm-searchMatch': {
      backgroundColor: 'rgba(243, 198, 123, 0.28)',
      outline: '1px solid var(--amber-line)',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: 'rgba(197, 247, 107, 0.32)',
      outline: '1px solid var(--lime)',
    },
  },
  { dark: true },
)

const highlightStyle = HighlightStyle.define([
  { tag: t.heading, color: '#c5f76b', fontWeight: '600' },
  { tag: t.propertyName, color: '#a9d5e8' },
  { tag: t.comment, color: '#6f828a', fontStyle: 'italic' },
  { tag: t.number, color: '#f3c67b' },
  { tag: t.string, color: '#b7df9b' },
  { tag: t.atom, color: '#e8b382' },
  { tag: t.meta, color: '#d7a8f2' },
  { tag: t.keyword, color: '#8fd7e8', fontWeight: '500' },
  { tag: t.variableName, color: '#dbe5e7' },
  { tag: t.punctuation, color: '#7d9199' },
])

export const stormtrooperEditorTheme = [editorBaseTheme, syntaxHighlighting(highlightStyle)]
