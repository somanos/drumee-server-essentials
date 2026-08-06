const Attr = require("./lex/attribute");
const Constants = require("./lex/constants");
const Logger = require("./logger");
const { sysEnv } = require("./sysEnv");

const { ERROR, YELLOW_PAGE, DB_HOST } = Constants;

const { isFunction, values, isArray, isObject, isEmpty, last } = require('lodash');
const { userInfo } = require('os');
let Mariadb;
const SENSITIVE = new RegExp(/password|passphrase|login|analytics_log/i);
const { db_user } = sysEnv();

class mariadb_stub extends Logger {

  constructor(...args) {
    super(...args);
    this.end = this.end.bind(this);
    this.log = this.log.bind(this);
    this._run = this._run.bind(this);
    this._handleError = this._handleError.bind(this);
    this.connection = this.connection.bind(this);
    this.call_proc = this.call_proc.bind(this);
    this.call_func = this.call_func.bind(this);
    this.query = this.query.bind(this);
  }

  /**
   * 
   * @param {*} opt 
   */
  initialize(opt = {}) {
    const dbConf = require('./configs')();

    this._dbname = this.get(Attr.name) || YELLOW_PAGE;
    this.isPersistent = 1;
    let { username } = userInfo();
    const dbuser = opt.user || db_user || username;
    this.configs = {
      host: DB_HOST,
      connectionLimit: opt.limit || 1,
      user: dbuser,
      socketPath: opt.socketPath,
      idleTimeout: 120,
      minDelayValidation: 0,
      ...dbConf,
      database: this._dbname,
    };
    if ((this.get(Attr.verbose) == null)) {
      this.set(Attr.verbose, 0);
    }
  }

  /**
   * 
   * @returns 
   */
  async getConnection() {
    if (!Mariadb) {
      Mariadb = await import('mariadb');
    }
    if (this._connection && this._connection.isValid()) {
      return this._connection;
    }
    try {
      this._connection = await Mariadb.createConnection(this.configs)
      return this._connection;
    } catch (err) {
      console.trace()
      this.warn("[FATAL]: not connected due to error ", err);
      throw err;
    }
  }

  /**
   * Lazily creates the connection pool. Only used when limit > 1;
   * instances with limit 1 keep the legacy single-connection behavior.
   * @returns
   */
  async getPool() {
    if (!Mariadb) {
      Mariadb = await import('mariadb');
    }
    if (!this._pool) {
      this._pool = Mariadb.createPool({ ...this.configs, minimumIdle: 1 });
    }
    return this._pool;
  }

  /**
   * 
   * @param {*} sql 
   * @param {*} val 
   * @returns 
   */
  _handleError(e) {
    let err = {
      dbname: this._dbname,
    }
    for (let k of ['sqlState', 'errno', 'code', 'message', 'sql']) {
      err[k] = e[k];
    }
    this.warn(`SQL failure:`, err);
    this.debug("Origin of error: ", this.__sql);
    if (global.LOG_LEVEL > 3) {
      console.trace();
    }
    
    if(this.get("throwOnError")){
      this.warn("Thrown by excplit option");
      throw e;
    } 

    if (e.fatal) {
      this.warn("FATAL ERROR RAISED -- RESETTING CONNECTION", e);
      this._connection = null;
      throw e;
    }
    switch (e.code) {
      case 'ER_CMD_CONNECTION_CLOSED':
      case 'ER_CONNECTION_TIMEOUT':
        this.warn("CONNECTION ERROR -- RESETTING CONNECTION", e);
        this._connection = null;
        this.trigger(ERROR, err);
        return;
      case 'ER_LOCK_DEADLOCK':
        return;
      default:
        if (this.isValid()) {
          this._connection.rollback();
        }
        this.trigger(ERROR, err);
        this.end();
    }
  }

  /**
   * 
   * @param {*} sql 
   * @param {*} val 
   * @returns 
   */
  log(sql, val) {
    if (!global.verbosity || global.verbosity <= 2) return;

    if (SENSITIVE.test(sql)) {
      return;
    }
    sql = sql.replace(/^(call +|select +)/, (a, b) => {
      let res = `${a}${this._dbname}.`;
      return res;
    })
    if (isArray(val)) {
      for (var i of val) {
        sql = sql.replace(/(\?)/, `'${i}'`);
      }
    }
    this.__sql = sql;
  }



  /**
   * 
   * @returns 
   */
  connection() {
    return this._connection;
  }

  /**
   * 
   * @returns 
   */
  isValid() {
    return (this._connection && this._connection.isValid());
  }

  /**
   * 
   * @param {*} args 
   * @param {*} method 
   * @returns 
   */
  statement(args, method = '') {
    const name = args.shift();
    let i = 0;
    let o = 0;
    let sql = `${method} ${name}(`;
    for (let a of args) {
      if ((a == null)) {
        args[i] = '';
      } else if (isObject(a) || isArray(a)) {
        args[i] = JSON.stringify(a);
      }
      let placeholder = '?';
      if (a && a.isOutput) {
        placeholder = `@output_${o}`;
        args.splice(i, 1);
        o++;
      }
      if (i < (args.length - 1)) {
        sql = `${sql} ${placeholder},`;
      } else {
        sql = `${sql} ${placeholder})`;
      }
      i++;
    }
    if (args.length < 1) {
      if (isEmpty(method)) {
        sql = name;
      } else {
        sql = `${method} ${name}()`;
      }
    }
    return sql;
  }

  /**
   * 
   * @param {*} args 
   * @param {*} method 
   * @returns 
   */
  async _run(args, method = '') {
    let handler;
    if (args.length < 1) {
      throw "Arguments required";
    }

    if (isFunction(last(args))) {
      handler = args.pop();
    }
    let sql;
    if (/^(call|select)$/i.test(method)) {
      sql = this.statement(args, method);
    } else {
      sql = args.shift();
    }
    this.log(sql, args);
    if (this.get(Attr.limit) > 1) {
      return this._runPooled(sql, args, handler);
    }
    let res = [];
    let c = null;
    try {
      c = await this.getConnection();
      if (!c.isValid()) {
        if (this._closed) {
          this.warn('Attempt to run after connection close');
          return { failed: 1, code: "CONNECTION_ALREADY_CLOSED" }
        }
        this.warn('Some abnormal errors occurred. Connection dropped');
        this.debug({ db: this._dbname, sql, args });
        this._connection = null;
        return { failed: 1, code: "CONNECTION_LOST" }
      }
    } catch (e) {
      this.warn('Failed to get DB connection', e);
      return { failed: 1, code: "CONNECTION_FAILED" }
    }
    return c.beginTransaction()
      .then(() => {
        return c.query(sql, args);
      })
      .then((rows) => {
        if (rows) {
          try {
            res = rows.get_rows();
          } catch (e) {
            res = rows;
          }
        }
        c.commit();
        if (isFunction(handler)) {
          return handler(res);
        }
        return res;
      })
      .catch(this._handleError);
  }

  /**
   * Runs a statement on a pooled connection. The pool acquires and
   * releases the connection around each statement (autocommit), so a
   * long-running call never blocks the other requests of the process.
   * @param {*} sql
   * @param {*} args
   * @param {*} handler
   * @returns
   */
  async _runPooled(sql, args, handler) {
    let pool;
    try {
      pool = await this.getPool();
    } catch (e) {
      this.warn('Failed to get DB pool', e);
      return { failed: 1, code: "CONNECTION_FAILED" }
    }
    return pool.query(sql, args)
      .then((rows) => {
        let res = [];
        if (rows) {
          try {
            res = rows.get_rows();
          } catch (e) {
            res = rows;
          }
        }
        if (isFunction(handler)) {
          return handler(res);
        }
        return res;
      })
      .catch(this._handleError);
  }


  /**
   * 
   * @returns 
   */
  call_proc() {
    return this._run(Array.prototype.slice.call(arguments), 'call')
      .then()
      .catch(this._handleError);
  }

  /**
   * 
   * @returns 
   */
  execute() {
    return this._execute(Array.prototype.slice.call(arguments), 'call')
      .then()
      .catch(this._handleError);
  }

  /**
   * 
   * @returns 
   */
  call_func() {
    return this._run(Array.prototype.slice.call(arguments), 'select')
      .then()
      .catch(this._handleError);
  }

  /**
   * Expect several rows as result
   * @returns 
   */
  query() {
    return this._run(Array.prototype.slice.call(arguments))
      .then()
      .catch(this._handleError);
  }

  /**
   * 
   * @returns 
   */
  async await_proc() {
    let args = Array.prototype.slice.call(arguments);
    let rows = await this._run(args, 'call');
    return rows;
  }

  /**
   * 
   * @returns 
   */
  async await_func() {
    let args = Array.prototype.slice.call(arguments);
    let rows = await this._run(args, 'select');
    return values(rows)[0];
  }

  /**
   * 
   * @returns 
   */
  async await_query() {
    let args = Array.prototype.slice.call(arguments);
    let rows = await this._run(args);
    return rows;
  }

  /**
   * 
   * @param {*} sql 
   * @param {*} args 
   * @returns 
   */
  async await_run(sql, args) {
    if (this.get(Attr.limit) > 1) {
      return this._runPooled(sql, args);
    }
    let c = await this.getConnection();
    return c.beginTransaction()
      .then(() => {
        return c.query(sql, args);
      })
      .then((rows) => {
        c.commit();
        let res = null;
        if (rows) {
          try {
            res = rows.get_rows();
          } catch (e) {
            res = rows;
          }
        }
        //c.release();
        return res;
      })
      .catch(this._handleError);
  }

  /**
   * 
   * @returns 
   */
  end() {
    this._closed = 1;
    try {
      this.silly("STOPING DB", this._dbname, this.isValid());
      if (!this.isValid() && !this._pool) {
        this.stop();
        return;
      }

      if ((this.get(Attr.limit) > 1) && this._pool) {
        this._pool.end().then(() => {
          this._pool = null;
          this._connection = null;
          this.stop();
        }).catch((e) => {
          console.warn("Error [end]: FAILED TO STOP CONNECTION", e);
          this.stop();
        });
        return
      }
      this._connection.end().then(() => {
        this._connection = null;
        this.stop();
      }).catch((e) => {
        console.warn("Error [end]: FAILED TO STOP CONNECTION", e);
        this.stop();
      });
    } catch (e) {
      console.warn("Error [end]: FAILED TO STOP POOL", e);
      this.stop();
    }
  }
}

module.exports = mariadb_stub;
