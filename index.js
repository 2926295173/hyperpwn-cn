const {homedir} = require('os')
const fs = require('fs-extra')
const path = require('path')
const yaml = require('yaml')
const merge = require('lodash.merge')
const stripAnsi = require('strip-ansi')
const expandTabs = require('expandtabs')
const cliTruncate = require('cli-truncate')
const ansiEscapes = require('ansi-escapes')

let hyperpwn
let contextStart
let contextData
let legendFix

const defaultConfig = {
  hotkeys: {
    prev: 'ctrl+shift+pageup',
    next: 'ctrl+shift+pagedown',
    cmd: {
      stepi: 'f7',
      nexti: 'f8'
    }
  },
  autoClean: false,
  autoLayout: true,
  showHeaders: true,
  headerStyle: {
    position: 'absolute',
    top: 0,
    right: 0,
    fontSize: '10px'
  }
}

const defaultShell =
{
  win32: {
    'default-shell': 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'default-shell-args': '& {Clear-Host; While($true) {Read-Host | Out-Null}}'
  },
  linux: {
    'default-shell': '/bin/sleep',
    'default-shell-args': 'infinity'
  },
  darwin: {
    'default-shell': '/bin/sleep',
    'default-shell-args': '100000000'
  }
}

let config = defaultConfig

class Hyperpwn {
  constructor() {
    this.index = null
    this.mainUid = null
    this.records = {}
    this.recordLen = 0
    this.legend = {uid: null, data: null, header: null}
    this.replayPrev = this.replayPrev.bind(this)
    this.replayNext = this.replayNext.bind(this)
    this.sendCmd = this.sendCmd.bind(this)
  }

  uids() {
    return Object.keys(this.records)
  }

  addUid(uid, name) {
    if (!this.records.hasOwnProperty(uid)) {
      this.records[uid] = []
    }
    this.records[uid].name = name
  }

  delUid(uid) {
    if (uid === this.legend.uid) {
      this.legend = {uid: null, data: null, header: null}
    } else {
      delete this.records[uid]
      if (this.uids().length === 0) {
        this.index = null
        this.recordLen = 0
      }
    }
  }

  addData(title, data) {
    return this.uids().some(uid => {
      if (title.toLowerCase().includes(this.records[uid].name.toLowerCase())) {
        this.records[uid].push(data)
        return true
      }
      return false
    })
  }

  alignData() {
    for (const uid of this.uids()) {
      if (this.records[uid].length === this.recordLen) {
        this.records[uid].push('')
      }
    }
    this.recordLen += 1
  }

  cleanData() {
    for (const uid of this.uids()) {
      const {name} = this.records[uid]
      this.records[uid] = []
      this.records[uid].name = name
    }
    this.index = null
    this.recordLen = 0
  }

  addLegend(data) {
    if (this.legend.data !== data) {
      this.legend.data = data
      this.store.dispatch({
        type: 'SESSION_PTY_DATA',
        uid: this.legend.uid,
        data: ansiEscapes.clearTerminal + data
      })
    }
  }

  uidHeader(uid) {
    if (uid === this.legend.uid) {
      return this.legend.header
    }
    if (uid in this.records) {
      return `[${this.records[uid].name}]`
    }
  }

  initSession(store, uid, backend) {
    this.store = store
    this.mainUid = uid
    const {termGroups} = store.getState().termGroups
    if (config.autoLayout && Object.keys(termGroups).length === 1) {
      this.loadLayout(backend)
    }
    if (config.autoClean) {
      this.cleanData()
    }
  }

  loadLayout(name) {
    if (this.uids().length === 0) {
      const cfgName = `hyperpwn-${name}.yml`
      const cfgPath = path.resolve(homedir(), '.hyperinator', cfgName)
      const libPath = path.resolve(__dirname, 'cfgs', cfgName)
      if (!fs.existsSync(cfgPath)) {
        const cfg = yaml.parse(fs.readFileSync(libPath, 'utf8'))
        cfg['global_options'] = defaultShell[process.platform]
        fs.outputFileSync(cfgPath, yaml.stringify(cfg))
      }

      this.store.dispatch({
        type: 'HYPERINATOR_LOAD',
        data: cfgPath
      })
    }
  }

  replayUid(uid, cols) {
    if (uid in this.records && Number.isInteger(this.index)) {
      let data = this.records[uid][this.index]
      data = data.replace(/^.*$/gm, line => cliTruncate(expandTabs(line), cols))
      data = ansiEscapes.clearTerminal + data
      this.store.dispatch({
        type: 'SESSION_PTY_DATA',
        uid,
        data
      })
    }
  }

  replay() {
    for (const uid of this.uids()) {
      const {cols} = this.store.getState().sessions.sessions[uid]
      this.replayUid(uid, cols)
    }
  }

  replayPrev() {
    if (this.index > 0) {
      this.index -= 1
      this.replay()
    }
  }

  replayNext() {
    if (this.index < this.recordLen - 1) {
      this.index += 1
      this.replay()
    }
  }

  replayLast() {
    if (this.recordLen) {
      this.index = this.recordLen - 1
      this.replay()
    }
  }

  sendCmd(cmd) {
    return () => {
      if (this.mainUid) {
        window.rpc.emit('data', {
          uid: hyperpwn.mainUid,
          data: '\b'.repeat(1000) + cmd + '\n'
        })
      }
    }
  }
}

exports.middleware = store => next => action => {
  const {type} = action

  if ((type === 'CONFIG_LOAD' || type === 'CONFIG_RELOAD') && action.config.hyperpwn) {
    config = merge(JSON.parse(JSON.stringify(defaultConfig)), action.config.hyperpwn)
  }

  if (type === 'SESSION_USER_DATA') {
    const {activeUid} = store.getState().sessions
    if (hyperpwn.uids().includes(activeUid)) {
      window.rpc.emit('data', {
        uid: hyperpwn.mainUid,
        data: action.data
      })
      store.dispatch({
        type: 'SESSION_SET_ACTIVE',
        uid: hyperpwn.mainUid
      })
      return
    }
  }

  if (type === 'SESSION_PTY_DATA') {
    const {uid} = action
    let data = action.data.replace(/\u0007{2,}/, '')
    action.data = data
    const strippedData = stripAnsi(data)
    if (strippedData.includes('Init PEDA')) {
      hyperpwn.initSession(store, uid, 'peda')
    }
    if (/GEF for (linux|darwin) ready/.test(strippedData)) {
      hyperpwn.initSession(store, uid, 'gef')
    }
    if (strippedData.includes('pwndbg: loaded ')) {
      hyperpwn.initSession(store, uid, 'pwndbg')
    }

    const view = /^.* hyperpwn (.*)[\r\n]+$/.exec(strippedData)
    if (view) {
      if (view[1].toLowerCase() === 'legend') {
        hyperpwn.legend.uid = uid
        hyperpwn.legend.header = `[${view[1]}]`
      } else {
        hyperpwn.addUid(uid, view[1])
      }
      action.data = ansiEscapes.cursorHide
    }

    if (uid !== hyperpwn.mainUid) {
      next(action)
      return
    }

    if (legendFix) {
      data = data.slice(2)
      legendFix = false
    }

    if (contextStart) {
      action.data = ''
      contextData += data
    }

    const legend = /(?:\[ )?legend: (.*?)]?$/gim.exec(data)
    if (legend) {
      contextStart = true
      hyperpwn.addLegend(legend[0])
      action.data = data.slice(0, legend.index)
      contextData = data.slice(legend.index + legend[0].length)
      if (contextData.length > 0) {
        contextData = contextData.slice(2)
      } else {
        legendFix = true
      }
    }

    if (contextStart && contextData.length > 0) {
      contextData = contextData.replace(/\r((?:\u001B\[[^m]*m)*)\n/g, '$1\r\n')
      const firstTitle = /^(?:\u001B\[[^m]*m)*\[?[-─]/.exec(contextData)
      if (!firstTitle) {
        contextStart = false
        action.data += contextData
        contextData = ''
      }

      const end = /\r\n(?:\u001B\[[^m]*m)*\[?[-─]+(?:\u001B\[[^m]*m)*[-─]+]?(?:\u001B\[[^m]*m)*\r\n/.exec(contextData)
      if (end) {
        let endDisp = false
        let dataAdded = false
        contextStart = false
        const tailData = contextData.slice(end.index + end[0].length)
        const partRegex = /^((?:\u001B\[[^m]*m)*\[?[-─]+.*[-─]+]?(?:\u001B\[[^m]*m)*)$/gm
        const parts = contextData.slice(0, end.index + 2).split(partRegex).slice(1)
        contextData = ''
        for (let i = 0; i < parts.length; i += 2) {
          if (hyperpwn.addData(parts[i], parts[i + 1].slice(2, -2))) {
            dataAdded = true
          } else {
            action.data += parts[i] + parts[i + 1]
            endDisp = true
          }
        }
        if (dataAdded) {
          hyperpwn.alignData()
        }
        hyperpwn.replayLast()

        if (endDisp) {
          action.data += end[0].slice(2)
        }
        setTimeout(() => {
          store.dispatch({
            type: 'SESSION_PTY_DATA',
            uid: hyperpwn.mainUid,
            data: tailData
          })
        }, 0)
      }
    }
    if (!action.data) {
      return
    }
  }

  if (type === 'SESSION_RESIZE') {
    hyperpwn.replayUid(action.uid, action.cols)
  }

  if (type === 'SESSION_PTY_EXIT') {
    hyperpwn.delUid(action.uid)
  }

  next(action)
}

exports.decorateConfig = mainConfig => {
  if (mainConfig.hyperpwn) {
    config = merge(JSON.parse(JSON.stringify(defaultConfig)), mainConfig.hyperpwn)
  }
  return mainConfig
}

exports.decorateKeymaps = keymaps => {
  const newKeymaps = {
    'pwn:replayprev': config.hotkeys.prev,
    'pwn:replaynext': config.hotkeys.next
  }
  for (const [k, v] of Object.entries(config.hotkeys.cmd)) {
    newKeymaps['pwn:cmd:' + k] = v
  }
  return Object.assign({}, keymaps, newKeymaps)
}

exports.decorateTerms = (Terms, {React}) => {
  return class extends React.Component {
    constructor(props, context) {
      super(props, context)
      this.onDecorated = this.onDecorated.bind(this)
      this.terms = null

      hyperpwn = new Hyperpwn()
    }

    onDecorated(terms) {
      this.terms = terms
      if (this.props.onDecorated) {
        this.props.onDecorated(terms)
      }

      if (this.terms) {
        const commands = {
          'pwn:replayprev': hyperpwn.replayPrev,
          'pwn:replaynext': hyperpwn.replayNext
        }
        for (const cmd of Object.keys(config.hotkeys.cmd)) {
          commands['pwn:cmd:' + cmd] = hyperpwn.sendCmd(cmd)
        }
        terms.registerCommands(commands)
      }
    }

    render() {
      return React.createElement(
        Terms,
        Object.assign({}, this.props, {
          onDecorated: this.onDecorated
        })
      )
    }
  }
}

exports.decorateTerm = (Term, {React}) => {
  return class extends React.Component {
    render() {
      const props = {}

      let header
      if (config.showHeaders) {
        header = hyperpwn.uidHeader(this.props.uid)
      }

      if (!header) {
        return React.createElement(Term, Object.assign({}, this.props, props))
      }

      const myCustomChildrenBefore = React.createElement(
        'div',
        {
          key: 'pwn',
          style: config.headerStyle
        },
        header
      )
      const customChildrenBefore = this.props.customChildrenBefore ?
        [this.props.customChildrenBefore].concat(myCustomChildrenBefore) :
        myCustomChildrenBefore
      props.customChildrenBefore = customChildrenBefore
      return React.createElement(Term, Object.assign({}, this.props, props))
    }
  }
}
