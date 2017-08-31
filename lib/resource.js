import _ from 'lodash';
import qs from 'qs';

require('isomorphic-fetch');

export const actionTypes = {
  await: 'RESOURCE_AWAIT_ACTION',
  create: 'RESOURCE_CREATE',
  fail: 'RESOURCE_FAIL_ACTION',
  get: 'RESOURCE_GET',
  query: 'RESOURCE_QUERY',
  receive: 'RESOURCE_RECEIVE',
  receiveMany: 'RESOURCE_RECEIVE_MANY',
  request: 'RESOURCE_API_REQUEST',
  succeed: 'RESOURCE_SUCCEED_ACTION',
  update: 'RESOURCE_UPDATE'
};

export const dataExtractors = {
  flat(data, extract) {
    _.isArray(data) ? _.each(data, extract) : extract(data);
  }
}

export default class Resource {
  constructor(config) {
    this.config = _.defaults(config, {
      actions: {},
      extractor: dataExtractors.flat,
      getSingleUri: (resource, spec) => `${resource.config.endpoint}/${spec.id}`,
      options: {},
      optimistic: false,
      responseHandler: response => response.json()
    });

    this.endpoint = this.config.endpoint;
    this.reducer = this._reducer.bind(this);
    this.middleware = this._middleware.bind(this);

    _.each(this.config.actions, (action, name) => {
      this[name] = (...args) => this._createAction(action.apply(this, args));
    });
  }

  getSingleUri(spec) { this.config.getSingleUri(this, spec); }

  _reducer(state = { items: {}, awaiting: [], resolved: [] }, action) {
    if (action.resource !== this.config.name) return state;

    switch (action.type) {
      case actionTypes.succeed:
      case actionTypes.fail:
        return {
          ...state,
          awaiting: _.reject(state.awaiting, { id: action.action.id }),
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
        const newItems = _.zipObject(_.map(action.items, item => {
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
      let waiter;

      if (action.resource !== this.config.name) return next(action);

      switch (action.type) {
        case actionTypes.await:
          dispatch(action.action);

          return next(action);
        case actionTypes.fail:
          waiter = _.findWhere(state.awaiting, { id: action.action.id });

          if (waiter) waiter.reject(action.response);

          return next(action);
        case actionTypes.succeed:
          waiter = _.findWhere(state.awaiting, { id: action.action.id });

          if (waiter) waiter.resolve(action.response);

          return next(action);
        case actionTypes.update:
          dispatch(this.request(action, {
            data: action.data,
            method: 'PATCH'
          }, this.getSingleUri({ ...action.data, id: action.id })));

          if (this.config.optimistic) {
            let item = state.items[action.id];

            dispatch(this.receive(action.id, {
              ...item,
              ...action.data
            }));
          }

          return next(action);
        case actionTypes.create:
          dispatch(this.request(action, {
            data: action.data,
            method: 'POST'
          }));

          return next(action);
        case actionTypes.query:
          dispatch(this.request(action, {
            method: 'GET',
            qs: action.params || {}
          }));

          return next(action);
        case actionTypes.get:
          dispatch(this.request(action, {
            method: 'GET'
          }, this.getSingleUri(action.params)));

          return next(action);
        case actionTypes.request:
          let options = action.options;
          let url = action.url;

          if (options.data) {
            options.body = JSON.stringify(options.data);

            delete options.data;
          }

          if (options.qs && !_.isEmpty(options.qs)) {
            url += `?${qs.stringify(options.qs)}`;
          }

          fetch(url, options)
            .then(response => {
              if (response.status >= 200 && response.status < 300) {

                return this.config.responseHandler(response);
              } else {
                let error = new Error(response.statusText);
                error.response = response;

                console.log('error', error);
                throw error;
              }
            })
            .then(data => {
              const items = [];

              dispatch(this.succeed(action.trigger, data));

              this.config.extractor(data, datum => {
                items.push({
                  attributes: datum,
                  id: datum.id
                });
              });

              dispatch(this.receiveMany(items));
            }, error => {
              if (!error || !error.response) {
                dispatch(this.fail(action.trigger, null, error));
              }

              error.response.json().then(data => {
                dispatch(this.fail(action.trigger, data, error));
              }, response => {
                dispatch(this.fail(action.trigger, null, error));
              });
            }
          ).catch(err => {
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
      action: action,
      error: error,
      resource: this.config.name,
      response: response,
      type: actionTypes.fail
    };
  }

  succeed(action, response) {
    return this._createAction({
      action: action,
      response: response,
      type: actionTypes.succeed
    });
  }

  await(dispatch, action) {
    return new Promise((resolve, reject) => {
      dispatch({
        action: action,
        reject: reject,
        resource: this.config.name,
        resolve: resolve,
        type: actionTypes.await
      });
    });
  }

  receive(id, attributes) {
    return {
      attributes: attributes
      id: id,
      resource: this.config.name,
      type: actionTypes.receive
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
      method: 'GET',
      headers: _.defaults(opts.headers || {}, this.config.options.headers || {}, {
        'Content-Type': 'application/vnd.api+json',
        'Accept': 'application/vnd.api+json'
      }),
      qs: _.defaults(opts.qs || {}, this.config.options.qs || {})
    });

    return this._createAction({
      options: options,
      trigger: trigger,
      type: actionTypes.request,
      url: endpoint
    });
  }

  create(data) {
    return {
      data: data,
      id: _.uniqueId(),
      resource: this.config.name,
      type: actionTypes.create
    };
  }

  update(id, data) {
    return this._createAction({
      data: data,
      id: id,
      type: actionTypes.update
    });
  }

  query(params) {
    return this._createAction({
      params: params,
      type: actionTypes.query
    });
  }

  get(params) {
    if (!_.isObject(params)) params = { id: params };

    return this._createAction({ params: params, type: actionTypes.get });
  }
}
