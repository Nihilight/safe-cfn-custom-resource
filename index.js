'use strict';

const { promisify } = require('util');
const cfnCR = require('cfn-custom-resource');
const { configure, LOG_DEBUG, CREATE, UPDATE, DELETE } = cfnCR;

const sendSuccess = promisify(cfnCR.sendSuccess);
// cfn-custom-resource's callback is the third argument, a little harder to promisify
const sendFailure = (reason, event, context, physicalResourceId) => {
  return new Promise((resolve, reject) => {
    cfnCR.sendFailure(
      reason, event,
      (err, data) => {
        if (!err) resolve(data);
        else reject(err);
      },
      context, physicalResourceId
    );
  });
};

// Configuring debug if DEBUG env variable is set.
if (process.env.DEBUG) configure({ logLevel: LOG_DEBUG });

/*
 * A class to handle the handler's logic, holding on to the data relevant to it.
 */
class Handler {
  constructor(event, context, resource, initErr) {
    this.event = event;
    this.context = context;
    this.resource = resource;
    this.initErr = initErr;
    this.responseSent = false;
  }

  /*
   * Does the actual handler logic, returns a promise to be returned to AWS Lambda.
   */
  async promise() {
    try {
      if (this.initErr) throw this.initErr;
      return await Promise.race([
        this.handleTimeout(),
        this.handleResource(),
      ]);
    } catch (err) {
      return await this.sendFailure({ reason: err });
    }
  }

  /*
   * Ensures CloudFormation gets a response at least 3 seconds before the function times out.
   */
  handleTimeout() {
    return new Promise((resolve, reject) => {
      setTimeout(
        () => reject("Function timed out (2 seconds prior to actual timeout)"),
        this.context.getRemainingTimeInMillis() - 2000
      );
    });
  }

  /*
   * Calls the resource's functions, depending on the event's RequestType.
   */
  async handleResource() {
    let resource = await this.resource; // initializer to return a promise
    switch (this.event.RequestType) {
      case CREATE: return await sendSuccess(await resource.create(this.event, this.context));
      case UPDATE: return await sendSuccess(await resource.update(this.event, this.context));
      case DELETE: return await sendSuccess(await resource.delete(this.event, this.context));
    }
  }

  /*
   * Wrapper around cfn-custom-resource's sendSuccess, with the Handler's data.
   */
  async sendSuccess({ id, data }) {
    if (this.responseSent) return;
    this.responseSent = true;
    return await sendSuccess(id, data, this.event);
  }

  /*
   * Wrapper around cfn-custom-resource's sendFailure, with the Handler's data.
   */
  async sendFailure({ reason, id }) {
    if (this.responseSent) return;
    this.responseSent = true;
    await sendFailure(reason, this.event, this.context, id);
    throw reason;
  }
}

/*
 * Wrapper that creates a safe handler for a CloudFormation custom resource lambda.
 *
 * @param {Function} initializer  All the user's code is to be done in this function.
 *                                The user's function needs to return an object in this format:
 *                                  {
 *                                    create: Function(event, context) => { id, data? },
 *                                    update: Function(event, context) => { id?, data? },
 *                                    delete: Function(event, context),
 *                                  }
 * @return {Function}             The handler to be used for the custom resource's lambda:
 *                                  Function(event, context) => Promise
 */
function wrapper(initializer) {
  let resource;
  let initErr;
  try {
    resource = initializer();
  } catch (err) {
    initErr = err || "Unknown error during initialization (before the handler was invoked)";
  }

  return async (event, context) => {
    return await Handler(event, context, resource, initErr).promise();
  };
}

module.exports = wrapper;
