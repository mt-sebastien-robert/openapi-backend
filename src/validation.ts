import _ from 'lodash';
import Ajv from 'ajv';
import { OpenAPIV3 } from 'openapi-types';
import { OpenAPIRouter, Request, Operation } from './router';

// alias Document to OpenAPIV3.Document
type Document = OpenAPIV3.Document;

/**
 * The output object for validationRequest. Contains the results for validation
 *
 * @export
 * @interface ValidationStatus
 */
export interface ValidationResult {
  valid: boolean;
  errors?: Ajv.ErrorObject[];
}

/**
 * The internal JSON schema model to validate InputParameters against
 *
 * @interface InputValidationSchema
 */
interface InputValidationSchema {
  title: string;
  type: 'object';
  additionalProperties?: boolean;
  properties: {
    [target: string]: OpenAPIV3.SchemaObject | OpenAPIV3.ArraySchemaObject | OpenAPIV3.NonArraySchemaObject;
  };
  required?: string[];
}

/**
 * The internal input parameters object to validate against InputValidateSchema
 *
 * @interface InputParameters
 */
interface InputParameters {
  path?: { [param: string]: string };
  query?: { [param: string]: string };
  header?: { [header: string]: string };
  cookie?: { [cookie: string]: string };
  requestBody?: any;
}

/**
 * Class that handles JSON schema validation
 *
 * @export
 * @class OpenAPIValidator
 */
export class OpenAPIValidator {
  public definition: Document;
  public ajvOpts: Ajv.Options;
  public requestValidators: { [operationId: string]: Ajv.ValidateFunction[] };
  public responseValidators: { [operationId: string]: Ajv.ValidateFunction };
  public router: OpenAPIRouter;

  /**
   * Creates an instance of OpenAPIValidation
   *
   * @param opts - constructor options
   * @param {Document | string} opts.definition - the OpenAPI definition, file path or Document object
   * @param {{ [operationId: string]: Handler | ErrorHandler }} opts.handlers - Operation handlers to be registered
   * @memberof OpenAPIRequestValidator
   */
  constructor(opts: { definition: Document; ajvOpts?: Ajv.Options }) {
    this.definition = opts.definition;
    this.ajvOpts = opts.ajvOpts || {};

    // initalize router
    this.router = new OpenAPIRouter({ definition: this.definition });

    // get defined api operations
    const operations = this.router.getOperations();

    // build request validation schemas for api operations
    this.requestValidators = {};
    operations.map(this.buildRequestValidatorsForOperation.bind(this));

    // build response validation schemas for api operations
    this.responseValidators = {};
    operations.map(this.buildResponseValidatorForOperation.bind(this));
  }

  /**
   * Validates a request against prebuilt Ajv validators and returns the validation result.
   *
   * The method will first match the request to an API operation and use the pre-compiled Ajv validation schema to
   * validate it.
   *
   * @param {Request} req - request to validate
   * @param {(Operation | string)} operation - operation to validate against
   * @returns {ValidationResult}
   * @memberof OpenAPIRequestValidator
   */
  public validateRequest(req: Request, operation?: Operation | string): ValidationResult {
    const result: ValidationResult = {
      valid: true,
      errors: [],
    };

    if (!operation) {
      operation = this.router.matchOperation(req);
    } else if (typeof operation === 'string') {
      operation = this.router.getOperation(operation);
    }

    if (!operation || !operation.operationId) {
      throw new Error(`Unknown operation`);
    }

    // get pre-compiled ajv schemas for operation
    const { operationId } = operation;
    const validators = this.getRequestValidatorsForOperation(operationId);

    // build a parameter object to validate
    const { params, query, headers, cookies, requestBody } = this.router.parseRequest(req, operation.path);

    // convert singular query parameters to arrays if specified as array in operation parametes
    for (const [name, value] of _.entries(query)) {
      if (typeof value === 'string') {
        const operationParameter = _.find(operation.parameters, { name, in: 'query' });
        if (operationParameter) {
          const { schema } = operationParameter as OpenAPIV3.ParameterObject;
          if (schema && (schema as OpenAPIV3.SchemaObject).type === 'array') {
            query[name] = [value];
          }
        }
      }
    }

    const parameters: InputParameters = _.omitBy(
      {
        path: params,
        query,
        header: headers,
        cookie: cookies,
      },
      _.isNil,
    );

    if (typeof req.body !== 'object' && req.body !== undefined) {
      const payloadFormats = _.keys(_.get(operation, 'requestBody.content', {}));
      if (payloadFormats.length === 1 && payloadFormats[0] === 'application/json') {
        // check that JSON isn't malformed when the only payload format is JSON
        try {
          JSON.parse(`${req.body}`);
        } catch (err) {
          result.errors.push({
            keyword: 'parse',
            dataPath: '',
            schemaPath: '#/requestBody',
            params: [],
            message: err.message,
          });
        }
      }
    }

    if (typeof requestBody === 'object' || headers['content-type'] === 'application/json') {
      // include request body in validation if an object is provided
      parameters.requestBody = requestBody;
    }

    // validate parameters against each pre-compiled schema
    for (const validate of validators) {
      validate(parameters);
      if (validate.errors) {
        result.errors.push(...validate.errors);
      }
    }

    if (_.isEmpty(result.errors)) {
      // set empty errors array to null so we can check for result.errors truthiness
      result.errors = null;
    } else {
      // there were errors, set valid to false
      result.valid = false;
    }
    return result;
  }

  /**
   * Validates a response against a prebuilt Ajv validator and returns the result
   *
   * @param {*} res
   * @param {(Operation | string)} [operation]
   * @returns {ValidationResult}
   * @memberof OpenAPIRequestValidator
   */
  public validateResponse(res: any, operation: Operation | string): ValidationResult {
    const result: ValidationResult = {
      valid: true,
      errors: [],
    };

    if (typeof operation === 'string') {
      operation = this.router.getOperation(operation);
    }

    if (!operation || !operation.operationId) {
      throw new Error(`Unknown operation`);
    }

    const { operationId } = operation;
    const validate = this.getResponseValidatorForOperation(operationId);

    if (validate) {
      validate(res);
      if (validate.errors) {
        result.errors.push(...validate.errors);
      }
    }

    if (_.isEmpty(result.errors)) {
      // set empty errors array to null so we can check for result.errors truthiness
      result.errors = null;
    } else {
      // there were errors, set valid to false
      result.valid = false;
    }
    return result;
  }

  /**
   * Get an array of request validator functions for an operation by operationId
   *
   * @param {string} operationId
   * @returns {Ajv.ValidateFunction[]}
   * @memberof OpenAPIRequestValidator
   */
  public getRequestValidatorsForOperation(operationId: string) {
    return this.requestValidators[operationId];
  }

  /**
   * Builds Ajv request validation functions for an operation and registers them to requestValidators
   *
   * @param {Operation} operation
   * @memberof OpenAPIRequestValidator
   */
  public buildRequestValidatorsForOperation(operation: Operation): void {
    const { operationId } = operation;

    // validator functions for this operation
    const validators: Ajv.ValidateFunction[] = [];

    // schema for operation requestBody
    if (operation.requestBody) {
      const requestBody = operation.requestBody as OpenAPIV3.RequestBodyObject;
      const jsonbody = requestBody.content['application/json'];
      if (jsonbody && jsonbody.schema) {
        const requestBodySchema: InputValidationSchema = {
          title: 'Request',
          type: 'object',
          additionalProperties: true,
          properties: {
            requestBody: jsonbody.schema as OpenAPIV3.SchemaObject,
          },
          required: [],
        };
        if (_.keys(requestBody.content).length === 1) {
          // if application/json is the only specified format, it's required
          requestBodySchema.required.push('requestBody');
        }

        // add compiled params schema to schemas for this operation id
        const requstBodyValidator = new Ajv(this.ajvOpts);
        validators.push(requstBodyValidator.compile(requestBodySchema));
      }
    }

    // schema for operation parameters in: path,query,header,cookie
    const paramsSchema: InputValidationSchema = {
      title: 'Request',
      type: 'object',
      additionalProperties: true,
      properties: {
        path: {
          type: 'object',
          additionalProperties: false,
          properties: {},
          required: [],
        },
        query: {
          type: 'object',
          properties: {},
          additionalProperties: false,
          required: [],
        },
        header: {
          type: 'object',
          additionalProperties: true,
          properties: {},
          required: [],
        },
        cookie: {
          type: 'object',
          additionalProperties: true,
          properties: {},
          required: [],
        },
      },
      required: [],
    };

    // params are dereferenced here, no reference objects.
    const { parameters } = operation;
    parameters.map((param: OpenAPIV3.ParameterObject) => {
      const target = paramsSchema.properties[param.in];
      if (param.required) {
        target.required.push(param.name);
        paramsSchema.required = _.uniq([...paramsSchema.required, param.in]);
      }
      target.properties[param.name] = param.schema as OpenAPIV3.SchemaObject;
    });

    // add compiled params schema to requestValidators for this operation id
    const paramsValidator = new Ajv({ ...this.ajvOpts, coerceTypes: true }); // types should be coerced for params
    validators.push(paramsValidator.compile(paramsSchema));
    this.requestValidators[operationId] = validators;
  }

  /**
   * Get response validator function for an operation by operationId
   *
   * @param {string} operationId
   * @returns {Ajv.ValidateFunction}
   * @memberof OpenAPIRequestValidator
   */
  public getResponseValidatorForOperation(operationId: string) {
    return this.responseValidators[operationId];
  }

  /**
   * Builds an ajv response validator function for an operation and registers it to responseValidators
   *
   * @param {Operation} operation
   * @memberof OpenAPIRequestValidator
   */
  public buildResponseValidatorForOperation(operation: Operation): void {
    if (!operation.responses) {
      // operation has no responses, don't register a validator
      return null;
    }

    const { operationId } = operation;
    const responseSchemas: OpenAPIV3.SchemaObject[] = [];

    _.mapKeys(operation.responses, (response: OpenAPIV3.ResponseObject, status) => {
      if (response.content && response.content['application/json'] && response.content['application/json'].schema) {
        responseSchemas.push(response.content['application/json'].schema as OpenAPIV3.SchemaObject);
      }
      return null;
    });

    if (_.isEmpty(responseSchemas)) {
      // operation has no response schemas, don't register a validator
      return null;
    }

    // compile the validator function and register to responseValidators
    const schema = { oneOf: responseSchemas };
    const validator = new Ajv(this.ajvOpts);
    this.responseValidators[operationId] = validator.compile(schema);
  }
}
