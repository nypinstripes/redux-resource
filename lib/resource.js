var _ = require('lodash');
var qs = require('qs');

require('isomorphic-fetch');

export const actionTypes = {
  request: 'RESOURCE_API_REQUEST',
  create: 'RESOURCE_CREATE',
  get: 'RESOURCE_GET',
  update: 'RESOURCE_UPDATE',
  query: 'RESOURCE_QUERY',
  receive: 'RESOURCE_RECEIVE',
  receiveMany: 'RESOURCE_RECEIVE_MANY',
  await: 'RESOURCE_AWAIT_ACTION',
  fail: 'RESOURCE_FAIL_ACTION',
  succeed: 'RESOURCE_SUCCEED_ACTION',
};

export const dataExtractors = {
  flat(data, extract) {
    if (_.isArray(data)) {
      _.each(data, extract);
    } else {
      extract(data);
    }
  }
}

export default class Resource {
  constructor(config) {
    this.config = _.defaults(config, {
      options: {},
      actions: {},
      extractor: dataExtractors.flat,
      responseHandler: (response) => {
        return response.json();
      },
      optimistic: false,
      getSingleUri: (resource, spec) => {
        return `${resource.config.endpoint}/${spec.id}`
      }
    });

    this.endpoint = this.config.endpoint;

    this.reducer = this._reducer.bind(this);
    this.middleware = this._middleware.bind(this);

    _.each(this.config.actions, (action, name) => {
      this[name] = (...args) => {
        const actionCreator = action.apply(this, args);
        return this._createAction(actionCreator);
      };
    });
  }

  getSingleUri(spec) {
    return this.config.getSingleUri(this, spec);
  }

  _reducer(state = {items: {}, awaiting: [], resolved: []}, action) {
    if (action.resource !== this.config.name) {
      return state;
    }

    switch (action.type) {
      case actionTypes.succeed:
      case actionTypes.fail:
        return {
          ...state,
          awaiting: _.reject(state.awaiting, {id: action.action.id}),
          resolved: [...state.resolved, action.action]
        };
      case actionTypes.await:
        return {
          ...state,
          awaiting: [
            ...state.awaiting,
            {
              id: action.action.id,
              resolve: action.resolve,
              reject: action.reject
            }
          ]
        };
      case actionTypes.receive:
        return {
          ...state,
          items: {
            ...state.items,
            [action.id]: {
              id: action.id,
              ...action.attributes
            }
          }
        };
      case actionTypes.receiveMany:
        const newItems = _.zipObject(_.map(action.items, (item) => {
          return [item.id, {
            id: item.id,
            ...item.attributes
          }];
        }));
        return {
          ...state,
          items: {
            ...state.items,
            ...newItems
          }
        };
      default:
        return state;
    }
  }

  _middleware(store) {
    return next => action => {
      const dispatch = store.dispatch;
      const state = store.getState()[this.config.name];

      if (action.resource !== this.config.name) {
        return next(action);
      }

      let waiter;

      switch (action.type) {
        case actionTypes.await:
          dispatch(action.action);
          return next(action);
        case actionTypes.fail:
          waiter = _.findWhere(state.awaiting, {id: action.action.id});
          if (waiter) {
            waiter.reject(action.response);
          }
          return next(action);
        case actionTypes.succeed:
          waiter = _.findWhere(state.awaiting, {id: action.action.id});
          if (waiter) {
            waiter.resolve(action.response);
          }
          return next(action);
        case actionTypes.update:
          dispatch(this.request(action, {
            method: "PATCH",
            data: action.data
          }, this.getSingleUri({...action.data, id: action.id})));
          if (this.config.optimistic) {
            var item = state.items[action.id];
            dispatch(this.receive(action.id, {
              ...item,
              ...action.data
            }));
          }
          return next(action);
        case actionTypes.create:
          dispatch(this.request(action, {
            method: "POST",
            data: action.data
          }));
          return next(action);
        case actionTypes.query:
          dispatch(this.request(action, {
            method: "GET",
            qs: action.params || {}
          }));
          return next(action);
        case actionTypes.get:
          dispatch(this.request(action, {
            method: "GET"
          }, this.getSingleUri(action.params)));
          return next(action);
        case actionTypes.request:
          var options = action.options;
          var url = action.url;

          if (options.data) {
            options.body = JSON.stringify(options.data);
            delete options.data;
          }

          if (options.qs && !_.isEmpty(options.qs)) {
            url = url + '?' + qs.stringify(options.qs);
          }

          fetch(url, options)
            .then((response) => {
              if (response.status >= 200 && response.status < 300) {
                return this.config.responseHandler(response);
              } else {
                var error = new Error(response.statusText);
                error.response = response;
                // console.log("error", error);
                throw error;
              }
            })
            .then((data) => {
              dispatch(this.succeed(action.trigger, data));
              const items = [];
              this.config.extractor(data, (datum) => {
                items.push({
                  id: datum.id,
                  attributes: datum
                });
              });

              dispatch(this.receiveMany(items));
            }, (error) => {
              if (!error || !error.response) {
                dispatch(this.fail(action.trigger, null, error));
              }
              error.response.json().then((data) => {
                dispatch(this.fail(action.trigger, data, error));
              }, (response) => {
                dispatch(this.fail(action.trigger, null, error));
              });
            })
            .catch((err) => {
              dispatch(this.fail(action.trigger, null, err));
            });
          return next(action);
        default:
          return next(action);
      }
    };
  }

  _createAction(action) {
    return {
      resource: this.config.name,
      id: _.uniqueId(),
      ...action
    };
  }

  fail(action, response, error) {
    return {
      type: actionTypes.fail,
      resource: this.config.name,
      action: action,
      response: response,
      error: error
    };
  }

  succeed(action, response) {
    return this._createAction({
      type: actionTypes.succeed,
      action: action,
      response: response
    });
  }

  await(dispatch, action) {
    return new Promise((resolve, reject) => {
      dispatch({
        type: actionTypes.await,
        resource: this.config.name,
        resolve: resolve,
        reject: reject,
        action: action
      });
    });
  }

  receive(id, attributes) {
    return {
      type: actionTypes.receive,
      resource: this.config.name,
      id: id,
      attributes: attributes
    };
  }

  receiveMany(items) {
    return {
      type: actionTypes.receiveMany,
      resource: this.config.name,
      items
    };
  }

  request(trigger, opts, endpoint = this.endpoint) {
    const options = _.defaults(opts, this.config.options || {}, {
      method: "GET",
      headers: _.defaults(opts.headers || {}, this.config.options.headers || {}, {
        "Content-Type": "application/vnd.api+json",
        "Accept": "application/vnd.api+json"
      }),
      qs: _.defaults(opts.qs || {}, this.config.options.qs || {})
    });

    return this._createAction({
      type: actionTypes.request,
      trigger: trigger,
      url: endpoint,
      options: options,
    });
  }

  create(data) {
    return {
      type: actionTypes.create,
      resource: this.config.name,
      id: _.uniqueId(),
      data: data
    };
  }

  update(id, data) {
    return this._createAction({
      type: actionTypes.update,
      id: id,
      data: data
    });
  }

  query(params) {
    return this._createAction({
      type: actionTypes.query,
      params: params
    });
  }

  get(params) {
    if (!_.isObject(params)) {
      params = {id: params};
    }
    return this._createAction({
      type: actionTypes.get,
      params: params
    });
  }
}
