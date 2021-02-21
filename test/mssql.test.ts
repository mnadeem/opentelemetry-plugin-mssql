import { context, setSpan } from '@opentelemetry/api';
import { ConsoleLogger } from '@opentelemetry/core';
import { NodeTracerProvider } from '@opentelemetry/node';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/tracing';

import * as assert from 'assert';
import * as mssql from 'mssql';
import * as Docker from './Docker';
import { MssqlInstrumentation } from '../src/mssql';

const config: mssql.config = {
  user: process.env.MSSQL_USER || 'sa',
  password: process.env.MSSQL_PASSWORD || 'P@ssw0rd',
  server: process.env.MSSQL_HOST || 'localhost',  
  database: process.env.MSSQL_DATABASE || 'tempdb',
  port: 1433,
  options: {
    enableArithAbort: true,
    encrypt: false
  }
};
const instrumentation = new MssqlInstrumentation();

describe('mssql@6.x', () => {

    const testMssql = process.env.RUN_MSSQL_TESTS; // For CI: assumes local mysql db is already available
    const testMssqlLocally = process.env.RUN_MSSQL_TESTS_LOCAL || true; // For local: spins up local mysql db via docker
    const shouldTest = testMssql || testMssqlLocally; // Skips these tests if false (default)
  
    let contextManager: AsyncHooksContextManager;

    const provider = new NodeTracerProvider();
    const logger = new ConsoleLogger();
    const memoryExporter = new InMemorySpanExporter();
    let pool: mssql.ConnectionPool;

    before(function (done) {
        if (!shouldTest) {
          // this.skip() workaround
          // https://github.com/mochajs/mocha/issues/2683#issuecomment-375629901
          this.test!.parent!.pending = true;
          console.log('Skipping tests...');
          this.skip();
        }
        provider.addSpanProcessor(new SimpleSpanProcessor(memoryExporter));
        instrumentation.setTracerProvider(provider);
        if (testMssqlLocally) {
          console.log('Starting mssql...');
          Docker.start('mssql');
          // wait 15 seconds for docker container to start
          this.timeout(20000);
          setTimeout(done, 15000);
        } else {
          done();
        }
    });

    after(function () {
      if (testMssqlLocally) {
        this.timeout(5000);
        console.log('Stopping mssql...');
        Docker.cleanUp('mssql');
      }
    });

    beforeEach(async () => {
        contextManager = new AsyncHooksContextManager().enable();
        context.setGlobalContextManager(contextManager);
        instrumentation.enable();
        
        //start pool        
        pool = new mssql.ConnectionPool(config, (err) => {
          if (err) {
            logger.error("SQL Connection Establishment ERROR: %s", err);
          } else {
            logger.debug('SQL Connection established...');
          }
        });
        await pool.connect()
        pool.on('error', err => {
          console.log(" err " + err);
        });
        
      });
    
      afterEach(done => {
        context.disable();
        memoryExporter.reset();
        instrumentation.disable();
        // end pool
        pool.close().finally(() => {
          done();
        });        
      });

      it('should export a plugin', () => {
        assert(instrumentation instanceof MssqlInstrumentation);
      });
    
      it('should have correct moduleName', () => {
        assert.strictEqual(instrumentation.instrumentationName, 'opentelemetry-instrumentation-mssql');
      });

      describe('when the query is a string', () => {

        it('should name the span accordingly ', done => {

          pool.connect().then((result) => {

            const span = provider.getTracer('default').startSpan('test span');
            context.with(setSpan(context.active(), span), () => {
              const request = new mssql.Request(pool);
              request.query('SELECT 1 as number').then((result) => {
                //console.log(result);
              }).catch(error =>{
                console.log("child erro " + error);
              }).finally(() => {
                const spans = memoryExporter.getFinishedSpans();
                //console.log(spans[0]);
                assert.strictEqual(spans[0].name, 'SELECT');
                done();
              });

            });
          })

        });
      });
    
});