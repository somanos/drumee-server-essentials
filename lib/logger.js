
// ================================  *
//   Copyright Xialia.com  2013-2023 *
//   FILE  : mariadb.js
//   TYPE  : module
// ================================  *


const {
  isEmpty, isArray, isString, isObject,
  keys, template, isFunction, delay
} = require('lodash');

const Attr = require('./lex/attribute');

const { STORAGE_FOLDER } = require('./lex/constants');
const { sysEnv } = require('./sysEnv');
const { runtime_dir, data_dir } = sysEnv();

const SYS_KEYS = new RegExp(/^mfs_|^.+secret$|session_id|^password$|db_name|^finger|home_dir|^sys_|_root$|_host$|_db$|^activation_/i);

const SYS_VALUES = new RegExp(`^(${runtime_dir}|${data_dir})/`);

const { existsSync, mkdirSync, readFileSync } = require('fs');
const { resolve, normalize, join, dirname } = require('path');

const Cache = require("./cache");
const MemoryWatch = require("./memory-watch");

const LEVEL = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  NOTICE: 2,
  DEBUG: 3,
  VERBOSE: 4,
  SILLY: 5
}

let SyslogClient;

/**
 * 
 * @returns 
 */
function now() {
  return new Date().toISOString();
}

/**
 * 
 * @param {*} level 
 * @param {*} module 
 * @returns 
 */
function level(level, module) {
  if (!global.debug) {
    return 0;
  }
  return parseInt(global.debug[module]) || parseInt(LEVEL[global.debug[module]]) || 0;
}

/**
 * 
 * @param {*} l 
 * @param {*} module 
 * @returns 
 */
function say(l, module) {
  let now = new Date().toISOString();
  let v = level(l, module) | global.verbosity;
  if (v < (LEVEL[l] || 10)) return;
  return `[${now}] ${module}[${l}]:`;
}


const Backbone = require('backbone');
class logger extends Backbone.Model {
  static verbosity() {
    return LEVEL;
  }

  /**
   *
   */
  preinitialize() {
    MemoryWatch.track(this);
  }

  /**
   * 
   * @param  {...any} args 
   */
  error(...args) {
    console.error(`[${now()}] ${this.constructor.name}[ERROR]:`, ...args);
  };

  /**
   * 
   * @param  {...any} args 
   */
  warn(...args) {
    console.warn(`[${now()}] ${this.constructor.name}[WARN]:`, ...args);
  };

  /**
   * 
   * @param  {...any} args 
   * @returns 
   */
  info(...args) {
    let word = say('INFO', this.constructor.name)
    console.trace();
    console.log("The method info is deprecated. Please use notice instead");
    if (!word) return;
    console.info(word, ...args);
  };

  /**
    * 
    * @param  {...any} args 
    * @returns 
    */
  notice(...args) {
    let word = say('NOTICE', this.constructor.name)
    if (!word) return;
    console.info(word, ...args);
  };


  /**
   * 
   * @param  {...any} args 
   * @returns 
   */
  verbose(...args) {
    let word = say('VERBOSE', this.constructor.name)
    if (!word) return;
    console.info(word, ...args);
  };

  /**
   * 
   * @param  {...any} args 
   * @returns 
   */
  debug(...args) {
    let word = say('DEBUG', this.constructor.name)
    if (!word) return;
    console.log(word, ...args);
  };


  /**
   * 
   * @param  {...any} args 
   * @returns 
   */
  silly(...args) {
    let word = say('SILLY', this.constructor.name)
    if (!word) return;
    console.info(word, ...args);
  };

  /**
   * 
   * @param {*} e 
   */
  fallback(e) {
    console.warn(`==========> FALLBACK STACK:\n`);
    throw (e);
  };

  syslog(...args) {
    if (!SyslogClient) {
      const Syslog = require("syslog-client-tls");
      SyslogClient = Syslog.createClient("127.0.0.1");
    }
    let me = this.constructor.name || process.env.instance_name || 'offline';
    let word = say('SYSLOG', me)
    SyslogClient.log(word + args.join(" "));
  };

  /**
 * 
 * @param {*} a 
 * @returns 
 */
  normalizeArgs(a) {
    let args;
    if (!isEmpty(a)) {
      args = Array.prototype.slice.call(a);
    } else {
      args = Array.prototype.slice.call(arguments);
    }
    switch (args.length) {
      case 1:
        if (isArray(args)) return args[0];
        return args;
      case 2:
        if (isString(args[0])) {
          return { service: args[0], data: args[1] }
        }
        return args;
      case 3:
        if (isString(args[0])) {
          return { service: args[0], recipient: args[1], data: args[2] }
        }
        return args;
      default:
        return args;
    }
  };


  /**
   * 
   * @param {*} l 
   * @returns 
   */
  randomString(l = 16) {
    let crypto = require("crypto");
    return crypto.randomBytes(16).toString('base64').replace(/[\+\/=]+/g, '');
  };


  /**
   * 
   * @param {*} a 
   * @returns 
   */
  parser(a) {
    let o = a.isData ? a : new Data(a);
    return o;
  };

  /**
   * 
   * @param {*} data 
   * @returns 
   */
  parseJSON(data) {
    if (isString(data)) {
      try {
        return JSON.parse(data);
      } catch (e) {
        this.warn("PARSE FAILED", `type=${typeof (data)}`, data, e);
        return data;
      }
    }
    return data;
  };


  /**
   * 
   * @param {*} item 
   * @returns 
   */
  sanitize(item) {
    if (isArray(item)) {
      // let res = item.filter(safe_value);
      for (let i = 0; i < item.length; i++) {
        let v = item[i];
        if (SYS_VALUES.test(v)) {
          delete item[k];
        } else if (isArray(v) || isObject(v)) {
          item[i] = this.sanitize(v);
        }
      }
      return item;
    }
    if (isObject(item)) {
      for (let k of keys(item)) {
        let v = item[k];
        //console.log("KEYS", k, v);
        if (typeof (v) === 'bigint') {
          v = Number(v)
        }
        if (SYS_KEYS.test(k) || SYS_VALUES.test(v)) {
          delete item[k];
        } else if (isArray(v) || isObject(v)) {
          item[k] = this.sanitize(v);
        }
      }
      return item;
    }
    if (isString(item)) {
      if (!SYS_VALUES.test(item)) return item;
      return "***";
    }
    return item;

  }

  /**
   * 
   * @param {*} item 
   * @returns 
   */
  cleanData(item) {
    return this.sanitize(this.toJSON());
  }


  /**
   * 
   * @param {*} model 
   * @param {*} options 
   * @returns 
   */
  payload(model, options) {
    let svc = null;
    let echoId;
    if (this.input && this.input.get) {
      if (options && options.service) {
        svc = options.service;
      } else {
        svc = this.input.get(Attr.service);
      }
      echoId = this.input.get("echoId")
      let sock_id = this.input.get(Attr.socket_id);
      if (sock_id) {
        let sender = { sock_id };
        if (this.uid) sender.uid = this.uid;
        if (this.user) {
          let { firstname, lastname, fullname, id } = this.user.toJSON();
          sender = { ...sender, firstname, lastname, fullname, id };
        }
        if (!options) {
          options = { sender };
        } else if (!options.sender) {
          options.sender = sender;
        } else {
          options.sender = { ...sender, ...options.sender };
        }
      }
    }
    if (this.__changelog) {
      let { args } = model;
      if (!args) {
        args = {
          changelog: this.__changelog
        }
      } else {
        if (!args.changelog) {
          args.changelog = this.__changelog
        }
      }
      model.args = args;
    }
    return {
      model,
      options: {
        service: svc,
        echoId,
        keys: '*',
        ...options
      },
    }
  }

  /**
   * 
   * @param {*} file 
   * @param {*} args 
   * @returns 
   */
  include(file, args) {
    let opt = { ...this.get(Attr.data), ...args };
    let tpl_dir = this.get('template_dir');
    let html_tpl;

    if (tpl_dir && existsSync(tpl_dir)) {
      html_tpl = resolve(tpl_dir, file);
    } else {
      const tpl_dir = this.get(Attr.base_dir) || '../templates/email';
      const dir = resolve(__dirname, tpl_dir);
      html_tpl = resolve(dir, file);
    }
    let html = readFileSync(html_tpl);
    html = String(html).trim().toString();
    const renderer = template(html, { imports: { renderer: this } });
    return renderer(opt);
  }

  /**
   * 
   * @param {*} a 
   * @returns 
   */
  stop(a) {
    if (this._stopping || this.isPersistent) return;
    let timer = setTimeout(() => {
      this.clear();
      for (let key of keys(this)) {
        let obj = this[key];
        if (obj) {
          if (obj._stopping || obj.isPersistent) {
            continue;
          } else {
            if (isFunction(obj.stop)) {
              try {
                obj.stop();
              } catch (e) {
                this.warn(`Failed to stop component ${key}`, e);
              }
            }
            if (isFunction(obj.clear)) {
              try {
                obj.clear();
              } catch (e) {
                this.warn(`Failed to clear component ${key}`, e);
              }
            }
            this[key] = null;
          }
        }
      }
      timer = null;
    }, 11000);
    this._stopping = 1;
    MemoryWatch.markStopped(this);
  };


  /**
   * 
   * @param {*} files 
   * @param {*} dest_dir 
   * @param {*} crop 
   * @returns 
   */
  makeArchiveList(files, dest_dir, crop) {
    let dest, src;
    let dump = [];
    for (let item of files) {
      if (isEmpty(item)) continue;
      src = join('/',
        item.home_dir,
        STORAGE_FOLDER,
        item.nid,
        `orig.${item.ext}`
      );

      // Clean null extension bugs
      item.filepath = item.filepath.replace(/\.null$/, '');
      item.filepath = decodeURI(encodeURI(normalize(item.filepath)));
      dest = join(dest_dir, item.filepath);
      if (/^(hub|folder)$/i.test(item.filetype)) {
        if (!existsSync(dest)) {
          mkdirSync(dest, { recursive: true });
        }
      } else {
        let dir = dirname(dest);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
      }
      dump.push({ src, dest, type: item.filetype });
    }
    return dump;
  }

  /**
   * 
   * @param {*} l 
   * @returns 
   */
  supportedLanguage(l) {
    let list = Cache.languages() || ['en', 'fr', 'ru', 'zh'];
    if (!l) return list;
    if (list.includes(l)) return l;
    return 'en';
  }

}

module.exports = logger;
