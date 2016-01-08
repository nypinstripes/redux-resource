var _ = require('lodash');
require('isomorphic-fetch');

export const actionTypes = {
	request: 'RESOURCE_API_REQUEST',
	create: 'RESOURCE_CREATE'
};

export default class Resource {
	constructor(config) {
		this.config = config;

		this.reducer = this._reducer.bind(this);
		this.middleware = this._middleware.bind(this);
	}

	_reducer(state = {}, action) {
		return state;
	}

	_middleware(store) {
		return next => action => {
			const dispatch = store.dispatch;
			const state = store.getState();

			if (action.resource !== this.config.name) {
				return next(action);
			}

			switch (action.type) {
				case actionTypes.create:
					dispatch(this.request(action, {
						method: "POST",
						data: {
							"type": this.config.name,
							"attributes": action.data
						}
					}));
					return next(action);
				case actionTypes.request:
					const options = action.options;
					if (options.data) {
						options.body = JSON.stringify({data: options.data});
						delete options.data;
					}
					fetch(action.url, options).then((response) => {
						console.log('response is', response.json());
					});
					console.log('fetch it!', fetch);
					return next(action);
				default:
					return next(action);
			}
		};
	}

	request(trigger, opts) {
		const options = _.defaults(opts, {
			method: "GET",
			headers: _.defaults(opts.headers || {}, {
				"Content-Type": "application/vnd.api+json",
				"Accept": "application/vnd.api+json"
			})
		});

		return {
			type: actionTypes.request,
			resource: this.config.name,
			trigger: trigger,
			url: this.config.endpoint,
			options: options
		};
	}

	create(data) {
		return {
			type: actionTypes.create,
			resource: this.config.name,
			data: data
		};
	}
}
