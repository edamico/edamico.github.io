(function (global, factory) {
    typeof exports === 'object' && typeof module !== 'undefined' ? factory(exports, require('automation-events')) :
    typeof define === 'function' && define.amd ? define(['exports', 'automation-events'], factory) :
    (global = typeof globalThis !== 'undefined' ? globalThis : global || self, factory(global.standardizedAudioContext = {}, global.automationEvents));
}(this, (function (exports, automationEvents) { 'use strict';

    const createAbortError = () => {
      try {
        return new DOMException('', 'AbortError');
      } catch (err) {
        // Bug #122: Edge is the only browser that does not yet allow to construct a DOMException.
        err.code = 20;
        err.name = 'AbortError';
        return err;
      }
    };

    const createAddAudioNodeConnections = audioNodeConnectionsStore => {
      return (audioNode, audioNodeRenderer, nativeAudioNode) => {
        const activeInputs = [];

        for (let i = 0; i < nativeAudioNode.numberOfInputs; i += 1) {
          activeInputs.push(new Set());
        }

        audioNodeConnectionsStore.set(audioNode, {
          activeInputs,
          outputs: new Set(),
          passiveInputs: new WeakMap(),
          renderer: audioNodeRenderer
        });
      };
    };

    const createAddAudioParamConnections = audioParamConnectionsStore => {
      return (audioParam, audioParamRenderer) => {
        audioParamConnectionsStore.set(audioParam, {
          activeInputs: new Set(),
          passiveInputs: new WeakMap(),
          renderer: audioParamRenderer
        });
      };
    };

    const ACTIVE_AUDIO_NODE_STORE = new WeakSet();
    const AUDIO_NODE_CONNECTIONS_STORE = new WeakMap();
    const AUDIO_NODE_STORE = new WeakMap();
    const AUDIO_PARAM_CONNECTIONS_STORE = new WeakMap();
    const AUDIO_PARAM_STORE = new WeakMap();
    const BACKUP_NATIVE_CONTEXT_STORE = new WeakMap();
    const CONTEXT_STORE = new WeakMap();
    const EVENT_LISTENERS = new WeakMap();
    const CYCLE_COUNTERS = new WeakMap(); // This clunky name is borrowed from the spec. :-)

    const NODE_NAME_TO_PROCESSOR_CONSTRUCTOR_MAPS = new WeakMap();
    const NODE_TO_PROCESSOR_MAPS = new WeakMap();

    const handler = {
      construct() {
        return handler;
      }

    };
    const isConstructible = constructible => {
      try {
        const proxy = new Proxy(constructible, handler);
        new proxy(); // tslint:disable-line:no-unused-expression
      } catch {
        return false;
      }

      return true;
    };

    /*
     * This massive regex tries to cover all the following cases.
     *
     * import './path';
     * import defaultImport from './path';
     * import { namedImport } from './path';
     * import { namedImport as renamendImport } from './path';
     * import * as namespaceImport from './path';
     * import defaultImport, { namedImport } from './path';
     * import defaultImport, { namedImport as renamendImport } from './path';
     * import defaultImport, * as namespaceImport from './path';
     */
    const IMPORT_STATEMENT_REGEX = /^import(?:(?:[\s]+[\w]+|(?:[\s]+[\w]+[\s]*,)?[\s]*\{[\s]*[\w]+(?:[\s]+as[\s]+[\w]+)?(?:[\s]*,[\s]*[\w]+(?:[\s]+as[\s]+[\w]+)?)*[\s]*}|(?:[\s]+[\w]+[\s]*,)?[\s]*\*[\s]+as[\s]+[\w]+)[\s]+from)?(?:[\s]*)("([^"\\]|\\.)+"|'([^'\\]|\\.)+')(?:[\s]*);?/; // tslint:disable-line:max-line-length

    const splitImportStatements = (source, url) => {
      const importStatements = [];
      let sourceWithoutImportStatements = source.replace(/^[\s]+/, '');
      let result = sourceWithoutImportStatements.match(IMPORT_STATEMENT_REGEX);

      while (result !== null) {
        const unresolvedUrl = result[1].slice(1, -1);
        const importStatementWithResolvedUrl = result[0].replace(/([\s]+)?;?$/, '').replace(unresolvedUrl, new URL(unresolvedUrl, url).toString());
        importStatements.push(importStatementWithResolvedUrl);
        sourceWithoutImportStatements = sourceWithoutImportStatements.slice(result[0].length).replace(/^[\s]+/, '');
        result = sourceWithoutImportStatements.match(IMPORT_STATEMENT_REGEX);
      }

      return [importStatements.join(';'), sourceWithoutImportStatements];
    };

    const verifyParameterDescriptors = parameterDescriptors => {
      if (parameterDescriptors !== undefined && !Array.isArray(parameterDescriptors)) {
        throw new TypeError('The parameterDescriptors property of given value for processorCtor is not an array.');
      }
    };

    const verifyProcessorCtor = processorCtor => {
      if (!isConstructible(processorCtor)) {
        throw new TypeError('The given value for processorCtor should be a constructor.');
      }

      if (processorCtor.prototype === null || typeof processorCtor.prototype !== 'object') {
        throw new TypeError('The given value for processorCtor should have a prototype.');
      }
    };

    const createAddAudioWorkletModule = (createNotSupportedError, evaluateSource, exposeCurrentFrameAndCurrentTime, fetchSource, getBackupNativeContext, getNativeContext, ongoingRequests, resolvedRequests, window) => {
      return (context, moduleURL, options = {
        credentials: 'omit'
      }) => {
        const nativeContext = getNativeContext(context);
        const absoluteUrl = new URL(moduleURL, window.location.href).toString(); // Bug #59: Only Chrome & Opera do implement the audioWorklet property.

        if (nativeContext.audioWorklet !== undefined) {
          return fetchSource(moduleURL).then(source => {
            const [importStatements, sourceWithoutImportStatements] = splitImportStatements(source, absoluteUrl);
            /*
             * Bug #170: Chrome and Opera do call process() with an array with empty channelData for each input if no input is
             * connected.
             *
             * This is the unminified version of the code used below:
             *
             * ```js
             * `${ importStatements };
             * ((registerProcessor) => {${ sourceWithoutImportStatements }
             * })((name, processorCtor) => registerProcessor(name, class extends processorCtor {
             *
             *     process (inputs, outputs, parameters) {
             *         return super.process(
             *             (inputs.map((input) => input.some((channelData) => channelData.length === 0)) ? [ ] : input),
             *             outputs,
             *             parameters
             *         );
             *     }
             *
             * }))`
             * ```
             */

            const wrappedSource = `${importStatements};(registerProcessor=>{${sourceWithoutImportStatements}
})((n,p)=>registerProcessor(n,class extends p{process(i,o,p){return super.process(i.map(j=>j.some(k=>k.length===0)?[]:j),o,p)}}))`;
            const blob = new Blob([wrappedSource], {
              type: 'application/javascript; charset=utf-8'
            });
            const url = URL.createObjectURL(blob);
            const backupNativeContext = getBackupNativeContext(nativeContext);
            const nativeContextOrBackupNativeContext = backupNativeContext !== null ? backupNativeContext : nativeContext;
            return nativeContextOrBackupNativeContext.audioWorklet.addModule(url, options).then(() => URL.revokeObjectURL(url)) // @todo This could be written more elegantly when Promise.finally() becomes avalaible.
            .catch(err => {
              URL.revokeObjectURL(url);

              if (err.code === undefined || err.name === 'SyntaxError') {
                err.code = 12;
              }

              throw err;
            });
          });
        }

        const resolvedRequestsOfContext = resolvedRequests.get(context);

        if (resolvedRequestsOfContext !== undefined && resolvedRequestsOfContext.has(moduleURL)) {
          return Promise.resolve();
        }

        const ongoingRequestsOfContext = ongoingRequests.get(context);

        if (ongoingRequestsOfContext !== undefined) {
          const promiseOfOngoingRequest = ongoingRequestsOfContext.get(moduleURL);

          if (promiseOfOngoingRequest !== undefined) {
            return promiseOfOngoingRequest;
          }
        }

        const promise = fetchSource(moduleURL).then(source => {
          const [importStatements, sourceWithoutImportStatements] = splitImportStatements(source, absoluteUrl);
          /*
           * This is the unminified version of the code used below:
           *
           * ```js
           * ${ importStatements };
           * ((a, b) => {
           *     (a[b] = a[b] || [ ]).push(
           *         (AudioWorkletProcessor, global, registerProcessor, sampleRate, self, window) => {
           *             ${ sourceWithoutImportStatements }
           *         }
           *     );
           * })(window, '_AWGS');
           * ```
           */
          // tslint:disable-next-line:max-line-length

          const wrappedSource = `${importStatements};((a,b)=>{(a[b]=a[b]||[]).push((AudioWorkletProcessor,global,registerProcessor,sampleRate,self,window)=>{${sourceWithoutImportStatements}
})})(window,'_AWGS')`; // @todo Evaluating the given source code is a possible security problem.

          return evaluateSource(wrappedSource);
        }).then(() => {
          const evaluateAudioWorkletGlobalScope = window._AWGS.pop();

          if (evaluateAudioWorkletGlobalScope === undefined) {
            throw new SyntaxError();
          }

          exposeCurrentFrameAndCurrentTime(nativeContext.currentTime, nativeContext.sampleRate, () => evaluateAudioWorkletGlobalScope(class AudioWorkletProcessor {}, undefined, (name, processorCtor) => {
            if (name.trim() === '') {
              throw createNotSupportedError();
            }

            const nodeNameToProcessorConstructorMap = NODE_NAME_TO_PROCESSOR_CONSTRUCTOR_MAPS.get(nativeContext);

            if (nodeNameToProcessorConstructorMap !== undefined) {
              if (nodeNameToProcessorConstructorMap.has(name)) {
                throw createNotSupportedError();
              }

              verifyProcessorCtor(processorCtor);
              verifyParameterDescriptors(processorCtor.parameterDescriptors);
              nodeNameToProcessorConstructorMap.set(name, processorCtor);
            } else {
              verifyProcessorCtor(processorCtor);
              verifyParameterDescriptors(processorCtor.parameterDescriptors);
              NODE_NAME_TO_PROCESSOR_CONSTRUCTOR_MAPS.set(nativeContext, new Map([[name, processorCtor]]));
            }
          }, nativeContext.sampleRate, undefined, undefined));
        }).catch(err => {
          if (err.code === undefined || err.name === 'SyntaxError') {
            err.code = 12;
          }

          throw err;
        });

        if (ongoingRequestsOfContext === undefined) {
          ongoingRequests.set(context, new Map([[moduleURL, promise]]));
        } else {
          ongoingRequestsOfContext.set(moduleURL, promise);
        }

        promise.then(() => {
          const rslvdRqstsFCntxt = resolvedRequests.get(context);

          if (rslvdRqstsFCntxt === undefined) {
            resolvedRequests.set(context, new Set([moduleURL]));
          } else {
            rslvdRqstsFCntxt.add(moduleURL);
          }
        }).catch(() => {}) // tslint:disable-line:no-empty
        // @todo Use finally when it becomes available in all supported browsers.
        .then(() => {
          const ngngRqstsFCntxt = ongoingRequests.get(context);

          if (ngngRqstsFCntxt !== undefined) {
            ngngRqstsFCntxt.delete(moduleURL);
          }
        });
        return promise;
      };
    };

    const createAddSilentConnection = createNativeGainNode => {
      return (nativeContext, nativeAudioScheduledSourceNode) => {
        const nativeGainNode = createNativeGainNode(nativeContext, {
          channelCount: 1,
          channelCountMode: 'explicit',
          channelInterpretation: 'discrete',
          gain: 0
        });
        nativeAudioScheduledSourceNode.connect(nativeGainNode)
        /*
         * Bug #50: Edge does not yet allow to create AudioNodes on a closed AudioContext. Therefore the context property is
         * used here to make sure to connect the right destination.
         */
        .connect(nativeGainNode.context.destination);

        const disconnect = () => {
          nativeAudioScheduledSourceNode.removeEventListener('ended', disconnect);
          nativeAudioScheduledSourceNode.disconnect(nativeGainNode);
          nativeGainNode.disconnect();
        };

        nativeAudioScheduledSourceNode.addEventListener('ended', disconnect);
      };
    };

    const createAddUnrenderedAudioWorkletNode = getUnrenderedAudioWorkletNodes => {
      return (nativeContext, audioWorkletNode) => {
        getUnrenderedAudioWorkletNodes(nativeContext).add(audioWorkletNode);
      };
    };

    const DEFAULT_OPTIONS = {
      channelCount: 2,
      channelCountMode: 'max',
      channelInterpretation: 'speakers',
      fftSize: 2048,
      maxDecibels: -30,
      minDecibels: -100,
      smoothingTimeConstant: 0.8
    };
    const createAnalyserNodeConstructor = (audionNodeConstructor, createAnalyserNodeRenderer, createIndexSizeError, createNativeAnalyserNode, getNativeContext, isNativeOfflineAudioContext) => {
      return class AnalyserNode extends audionNodeConstructor {
        constructor(context, options = DEFAULT_OPTIONS) {
          const nativeContext = getNativeContext(context);
          const mergedOptions = { ...DEFAULT_OPTIONS,
            ...options
          };
          const nativeAnalyserNode = createNativeAnalyserNode(nativeContext, mergedOptions);
          const analyserNodeRenderer = isNativeOfflineAudioContext(nativeContext) ? createAnalyserNodeRenderer() : null;
          super(context, false, nativeAnalyserNode, analyserNodeRenderer);
          this._nativeAnalyserNode = nativeAnalyserNode;
        }

        get fftSize() {
          return this._nativeAnalyserNode.fftSize;
        }

        set fftSize(value) {
          this._nativeAnalyserNode.fftSize = value;
        }

        get frequencyBinCount() {
          return this._nativeAnalyserNode.frequencyBinCount;
        }

        get maxDecibels() {
          return this._nativeAnalyserNode.maxDecibels;
        }

        set maxDecibels(value) {
          // Bug #118: Safari does not throw an error if maxDecibels is not more than minDecibels.
          const maxDecibels = this._nativeAnalyserNode.maxDecibels;
          this._nativeAnalyserNode.maxDecibels = value;

          if (!(value > this._nativeAnalyserNode.minDecibels)) {
            this._nativeAnalyserNode.maxDecibels = maxDecibels;
            throw createIndexSizeError();
          }
        }

        get minDecibels() {
          return this._nativeAnalyserNode.minDecibels;
        }

        set minDecibels(value) {
          // Bug #118: Safari does not throw an error if maxDecibels is not more than minDecibels.
          const minDecibels = this._nativeAnalyserNode.minDecibels;
          this._nativeAnalyserNode.minDecibels = value;

          if (!(this._nativeAnalyserNode.maxDecibels > value)) {
            this._nativeAnalyserNode.minDecibels = minDecibels;
            throw createIndexSizeError();
          }
        }

        get smoothingTimeConstant() {
          return this._nativeAnalyserNode.smoothingTimeConstant;
        }

        set smoothingTimeConstant(value) {
          this._nativeAnalyserNode.smoothingTimeConstant = value;
        }

        getByteFrequencyData(array) {
          this._nativeAnalyserNode.getByteFrequencyData(array);
        }

        getByteTimeDomainData(array) {
          this._nativeAnalyserNode.getByteTimeDomainData(array);
        }

        getFloatFrequencyData(array) {
          this._nativeAnalyserNode.getFloatFrequencyData(array);
        }

        getFloatTimeDomainData(array) {
          this._nativeAnalyserNode.getFloatTimeDomainData(array);
        }

      };
    };

    const isOwnedByContext = (nativeAudioNode, nativeContext) => {
      return nativeAudioNode.context === nativeContext;
    };

    const createAnalyserNodeRendererFactory = (createNativeAnalyserNode, getNativeAudioNode, renderInputsOfAudioNode) => {
      return () => {
        const renderedNativeAnalyserNodes = new WeakMap();

        const createAnalyserNode = async (proxy, nativeOfflineAudioContext, trace) => {
          let nativeAnalyserNode = getNativeAudioNode(proxy); // If the initially used nativeAnalyserNode was not constructed on the same OfflineAudioContext it needs to be created again.

          const nativeAnalyserNodeIsOwnedByContext = isOwnedByContext(nativeAnalyserNode, nativeOfflineAudioContext);

          if (!nativeAnalyserNodeIsOwnedByContext) {
            const options = {
              channelCount: nativeAnalyserNode.channelCount,
              channelCountMode: nativeAnalyserNode.channelCountMode,
              channelInterpretation: nativeAnalyserNode.channelInterpretation,
              fftSize: nativeAnalyserNode.fftSize,
              maxDecibels: nativeAnalyserNode.maxDecibels,
              minDecibels: nativeAnalyserNode.minDecibels,
              smoothingTimeConstant: nativeAnalyserNode.smoothingTimeConstant
            };
            nativeAnalyserNode = createNativeAnalyserNode(nativeOfflineAudioContext, options);
          }

          renderedNativeAnalyserNodes.set(nativeOfflineAudioContext, nativeAnalyserNode);
          await renderInputsOfAudioNode(proxy, nativeOfflineAudioContext, nativeAnalyserNode, trace);
          return nativeAnalyserNode;
        };

        return {
          render(proxy, nativeOfflineAudioContext, trace) {
            const renderedNativeAnalyserNode = renderedNativeAnalyserNodes.get(nativeOfflineAudioContext);

            if (renderedNativeAnalyserNode !== undefined) {
              return Promise.resolve(renderedNativeAnalyserNode);
            }

            return createAnalyserNode(proxy, nativeOfflineAudioContext, trace);
          }

        };
      };
    };

    const testAudioBufferCopyChannelMethodsOutOfBoundsSupport = nativeAudioBuffer => {
      try {
        nativeAudioBuffer.copyToChannel(new Float32Array(1), 0, -1);
      } catch {
        return false;
      }

      return true;
    };

    const createIndexSizeError = () => {
      try {
        return new DOMException('', 'IndexSizeError');
      } catch (err) {
        // Bug #122: Edge is the only browser that does not yet allow to construct a DOMException.
        err.code = 1;
        err.name = 'IndexSizeError';
        return err;
      }
    };

    const wrapAudioBufferGetChannelDataMethod = audioBuffer => {
      audioBuffer.getChannelData = (getChannelData => {
        return channel => {
          try {
            return getChannelData.call(audioBuffer, channel);
          } catch (err) {
            if (err.code === 12) {
              throw createIndexSizeError();
            }

            throw err;
          }
        };
      })(audioBuffer.getChannelData);
    };

    const DEFAULT_OPTIONS$1 = {
      numberOfChannels: 1
    };
    const createAudioBufferConstructor = (audioBufferStore, cacheTestResult, createNotSupportedError, nativeAudioBufferConstructor, nativeOfflineAudioContextConstructor, testNativeAudioBufferConstructorSupport, wrapAudioBufferCopyChannelMethods, wrapAudioBufferCopyChannelMethodsOutOfBounds) => {
      let nativeOfflineAudioContext = null;
      return class AudioBuffer {
        constructor(options) {
          if (nativeOfflineAudioContextConstructor === null) {
            throw new Error('Missing the native OfflineAudioContext constructor.');
          }

          const {
            length,
            numberOfChannels,
            sampleRate
          } = { ...DEFAULT_OPTIONS$1,
            ...options
          };

          if (nativeOfflineAudioContext === null) {
            nativeOfflineAudioContext = new nativeOfflineAudioContextConstructor(1, 1, 44100);
          }
          /*
           * Bug #99: Firefox does not throw a NotSupportedError when the numberOfChannels is zero. But it only does it when using the
           * factory function. But since Firefox also supports the constructor everything should be fine.
           */


          const audioBuffer = nativeAudioBufferConstructor !== null && cacheTestResult(testNativeAudioBufferConstructorSupport, testNativeAudioBufferConstructorSupport) ? new nativeAudioBufferConstructor({
            length,
            numberOfChannels,
            sampleRate
          }) : nativeOfflineAudioContext.createBuffer(numberOfChannels, length, sampleRate); // Bug #99: Safari does not throw an error when the numberOfChannels is zero.

          if (audioBuffer.numberOfChannels === 0) {
            throw createNotSupportedError();
          } // Bug #5: Safari does not support copyFromChannel() and copyToChannel().
          // Bug #100: Safari does throw a wrong error when calling getChannelData() with an out-of-bounds value.


          if (typeof audioBuffer.copyFromChannel !== 'function') {
            wrapAudioBufferCopyChannelMethods(audioBuffer);
            wrapAudioBufferGetChannelDataMethod(audioBuffer); // Bug #157: Only Chrome & Opera do allow the bufferOffset to be out-of-bounds.
          } else if (!cacheTestResult(testAudioBufferCopyChannelMethodsOutOfBoundsSupport, () => testAudioBufferCopyChannelMethodsOutOfBoundsSupport(audioBuffer))) {
            wrapAudioBufferCopyChannelMethodsOutOfBounds(audioBuffer);
          }

          audioBufferStore.add(audioBuffer);
          /*
           * This does violate all good pratices but it is necessary to allow this AudioBuffer to be used with native
           * (Offline)AudioContexts.
           */

          return audioBuffer;
        }

        static [Symbol.hasInstance](instance) {
          return instance !== null && typeof instance === 'object' && Object.getPrototypeOf(instance) === AudioBuffer.prototype || audioBufferStore.has(instance);
        }

      };
    };

    const MOST_NEGATIVE_SINGLE_FLOAT = -3.4028234663852886e38;
    const MOST_POSITIVE_SINGLE_FLOAT = -MOST_NEGATIVE_SINGLE_FLOAT;

    const getValueForKey = (map, key) => {
      const value = map.get(key);

      if (value === undefined) {
        throw new Error('A value with the given key could not be found.');
      }

      return value;
    };

    const getEventListenersOfAudioNode = audioNode => {
      return getValueForKey(EVENT_LISTENERS, audioNode);
    };

    const setInternalStateToActive = audioNode => {
      if (ACTIVE_AUDIO_NODE_STORE.has(audioNode)) {
        throw new Error('The AudioNode is already stored.');
      }

      ACTIVE_AUDIO_NODE_STORE.add(audioNode);
      getEventListenersOfAudioNode(audioNode).forEach(eventListener => eventListener(true));
    };

    const setInternalStateToPassive = audioNode => {
      if (!ACTIVE_AUDIO_NODE_STORE.has(audioNode)) {
        throw new Error('The AudioNode is not stored.');
      }

      ACTIVE_AUDIO_NODE_STORE.delete(audioNode);
      getEventListenersOfAudioNode(audioNode).forEach(eventListener => eventListener(false));
    };

    const DEFAULT_OPTIONS$2 = {
      buffer: null,
      channelCount: 2,
      channelCountMode: 'max',
      channelInterpretation: 'speakers',
      // Bug #149: Safari does not yet support the detune AudioParam.
      loop: false,
      loopEnd: 0,
      loopStart: 0,
      playbackRate: 1
    };
    const createAudioBufferSourceNodeConstructor = (audioNodeConstructor, createAudioBufferSourceNodeRenderer, createAudioParam, createInvalidStateError, createNativeAudioBufferSourceNode, getNativeContext, isNativeOfflineAudioContext, wrapEventListener) => {
      return class AudioBufferSourceNode extends audioNodeConstructor {
        constructor(context, options = DEFAULT_OPTIONS$2) {
          const nativeContext = getNativeContext(context);
          const mergedOptions = { ...DEFAULT_OPTIONS$2,
            ...options
          };
          const nativeAudioBufferSourceNode = createNativeAudioBufferSourceNode(nativeContext, mergedOptions);
          const isOffline = isNativeOfflineAudioContext(nativeContext);
          const audioBufferSourceNodeRenderer = isOffline ? createAudioBufferSourceNodeRenderer() : null;
          super(context, false, nativeAudioBufferSourceNode, audioBufferSourceNodeRenderer);
          this._audioBufferSourceNodeRenderer = audioBufferSourceNodeRenderer;
          this._isBufferNullified = false;
          this._isBufferSet = options.buffer !== null && options.buffer !== undefined;
          this._nativeAudioBufferSourceNode = nativeAudioBufferSourceNode;
          this._onended = null; // Bug #73: Edge & Safari do not export the correct values for maxValue and minValue.

          this._playbackRate = createAudioParam(this, isOffline, nativeAudioBufferSourceNode.playbackRate, MOST_POSITIVE_SINGLE_FLOAT, MOST_NEGATIVE_SINGLE_FLOAT);
        }

        get buffer() {
          if (this._isBufferNullified) {
            return null;
          }

          return this._nativeAudioBufferSourceNode.buffer;
        }

        set buffer(value) {
          // Bug #71: Edge does not allow to set the buffer to null.
          try {
            this._nativeAudioBufferSourceNode.buffer = value;
          } catch (err) {
            if (value !== null || err.code !== 17) {
              throw err;
            } // This will modify the buffer in place. Luckily that works in Edge and has the same effect as setting the buffer to null.


            if (this._nativeAudioBufferSourceNode.buffer !== null) {
              const buffer = this._nativeAudioBufferSourceNode.buffer;
              const numberOfChannels = buffer.numberOfChannels;

              for (let i = 0; i < numberOfChannels; i += 1) {
                buffer.getChannelData(i).fill(0);
              }

              this._isBufferNullified = true;
            }
          } // Bug #72: Only Chrome, Edge & Opera do not allow to reassign the buffer yet.


          if (value !== null) {
            if (this._isBufferSet) {
              throw createInvalidStateError();
            }

            this._isBufferSet = true;
          }
        }

        get loop() {
          return this._nativeAudioBufferSourceNode.loop;
        }

        set loop(value) {
          this._nativeAudioBufferSourceNode.loop = value;
        }

        get loopEnd() {
          return this._nativeAudioBufferSourceNode.loopEnd;
        }

        set loopEnd(value) {
          this._nativeAudioBufferSourceNode.loopEnd = value;
        }

        get loopStart() {
          return this._nativeAudioBufferSourceNode.loopStart;
        }

        set loopStart(value) {
          this._nativeAudioBufferSourceNode.loopStart = value;
        }

        get onended() {
          return this._onended;
        }

        set onended(value) {
          const wrappedListener = typeof value === 'function' ? wrapEventListener(this, value) : null;
          this._nativeAudioBufferSourceNode.onended = wrappedListener;
          const nativeOnEnded = this._nativeAudioBufferSourceNode.onended;
          this._onended = nativeOnEnded !== null && nativeOnEnded === wrappedListener ? value : nativeOnEnded;
        }

        get playbackRate() {
          return this._playbackRate;
        }

        start(when = 0, offset = 0, duration) {
          this._nativeAudioBufferSourceNode.start(when, offset, duration);

          if (this._audioBufferSourceNodeRenderer !== null) {
            this._audioBufferSourceNodeRenderer.start = duration === undefined ? [when, offset] : [when, offset, duration];
          } else {
            setInternalStateToActive(this);

            const resetInternalStateToPassive = () => {
              this._nativeAudioBufferSourceNode.removeEventListener('ended', resetInternalStateToPassive); // @todo Determine a meaningful delay instead of just using one second.


              setTimeout(() => setInternalStateToPassive(this), 1000);
            };

            this._nativeAudioBufferSourceNode.addEventListener('ended', resetInternalStateToPassive);
          }
        }

        stop(when = 0) {
          this._nativeAudioBufferSourceNode.stop(when);

          if (this._audioBufferSourceNodeRenderer !== null) {
            this._audioBufferSourceNodeRenderer.stop = when;
          }
        }

      };
    };

    const createAudioBufferSourceNodeRendererFactory = (connectAudioParam, createNativeAudioBufferSourceNode, getNativeAudioNode, renderAutomation, renderInputsOfAudioNode) => {
      return () => {
        const renderedNativeAudioBufferSourceNodes = new WeakMap();
        let start = null;
        let stop = null;

        const createAudioBufferSourceNode = async (proxy, nativeOfflineAudioContext, trace) => {
          let nativeAudioBufferSourceNode = getNativeAudioNode(proxy);
          /*
           * If the initially used nativeAudioBufferSourceNode was not constructed on the same OfflineAudioContext it needs to be created
           * again.
           */

          const nativeAudioBufferSourceNodeIsOwnedByContext = isOwnedByContext(nativeAudioBufferSourceNode, nativeOfflineAudioContext);

          if (!nativeAudioBufferSourceNodeIsOwnedByContext) {
            const options = {
              buffer: nativeAudioBufferSourceNode.buffer,
              channelCount: nativeAudioBufferSourceNode.channelCount,
              channelCountMode: nativeAudioBufferSourceNode.channelCountMode,
              channelInterpretation: nativeAudioBufferSourceNode.channelInterpretation,
              // Bug #149: Safari does not yet support the detune AudioParam.
              loop: nativeAudioBufferSourceNode.loop,
              loopEnd: nativeAudioBufferSourceNode.loopEnd,
              loopStart: nativeAudioBufferSourceNode.loopStart,
              playbackRate: nativeAudioBufferSourceNode.playbackRate.value
            };
            nativeAudioBufferSourceNode = createNativeAudioBufferSourceNode(nativeOfflineAudioContext, options);

            if (start !== null) {
              nativeAudioBufferSourceNode.start(...start);
            }

            if (stop !== null) {
              nativeAudioBufferSourceNode.stop(stop);
            }
          }

          renderedNativeAudioBufferSourceNodes.set(nativeOfflineAudioContext, nativeAudioBufferSourceNode);

          if (!nativeAudioBufferSourceNodeIsOwnedByContext) {
            // Bug #149: Safari does not yet support the detune AudioParam.
            await renderAutomation(nativeOfflineAudioContext, proxy.playbackRate, nativeAudioBufferSourceNode.playbackRate, trace);
          } else {
            // Bug #149: Safari does not yet support the detune AudioParam.
            await connectAudioParam(nativeOfflineAudioContext, proxy.playbackRate, nativeAudioBufferSourceNode.playbackRate, trace);
          }

          await renderInputsOfAudioNode(proxy, nativeOfflineAudioContext, nativeAudioBufferSourceNode, trace);
          return nativeAudioBufferSourceNode;
        };

        return {
          set start(value) {
            start = value;
          },

          set stop(value) {
            stop = value;
          },

          render(proxy, nativeOfflineAudioContext, trace) {
            const renderedNativeAudioBufferSourceNode = renderedNativeAudioBufferSourceNodes.get(nativeOfflineAudioContext);

            if (renderedNativeAudioBufferSourceNode !== undefined) {
              return Promise.resolve(renderedNativeAudioBufferSourceNode);
            }

            return createAudioBufferSourceNode(proxy, nativeOfflineAudioContext, trace);
          }

        };
      };
    };

    const isValidLatencyHint = latencyHint => {
      return latencyHint === undefined || typeof latencyHint === 'number' || typeof latencyHint === 'string' && (latencyHint === 'balanced' || latencyHint === 'interactive' || latencyHint === 'playback');
    };

    const createAudioContextConstructor = (baseAudioContextConstructor, createInvalidStateError, createNotSupportedError, createUnknownError, mediaElementAudioSourceNodeConstructor, mediaStreamAudioDestinationNodeConstructor, mediaStreamAudioSourceNodeConstructor, mediaStreamTrackAudioSourceNodeConstructor, nativeAudioContextConstructor) => {
      return class AudioContext extends baseAudioContextConstructor {
        constructor(options = {}) {
          if (nativeAudioContextConstructor === null) {
            throw new Error('Missing the native AudioContext constructor.');
          }

          const nativeAudioContext = new nativeAudioContextConstructor(options); // Bug #131 Safari returns null when there are four other AudioContexts running already.

          if (nativeAudioContext === null) {
            throw createUnknownError();
          } // Bug #51 Only Chrome and Opera throw an error if the given latencyHint is invalid.


          if (!isValidLatencyHint(options.latencyHint)) {
            throw new TypeError(`The provided value '${options.latencyHint}' is not a valid enum value of type AudioContextLatencyCategory.`);
          } // Bug #150 Only Chrome, Firefox and Opera support setting the sampleRate.


          if (options.sampleRate !== undefined && nativeAudioContext.sampleRate !== options.sampleRate) {
            throw createNotSupportedError();
          }

          super(nativeAudioContext, 2);
          const {
            latencyHint
          } = options;
          const {
            sampleRate
          } = nativeAudioContext; // @todo The values for 'balanced', 'interactive' and 'playback' are just copied from Chrome's implementation.

          this._baseLatency = typeof nativeAudioContext.baseLatency === 'number' ? nativeAudioContext.baseLatency : latencyHint === 'balanced' ? 512 / sampleRate : latencyHint === 'interactive' || latencyHint === undefined ? 256 / sampleRate : latencyHint === 'playback' ? 1024 / sampleRate :
          /*
           * @todo The min (256) and max (16384) values are taken from the allowed bufferSize values of a
           * ScriptProcessorNode.
           */
          Math.max(2, Math.min(128, Math.round(latencyHint * sampleRate / 128))) * 128 / sampleRate;
          this._nativeAudioContext = nativeAudioContext;
          this._state = null;
          /*
           * Bug #34: Chrome and Opera pretend to be running right away, but fire an onstatechange event when the state actually changes
           * to 'running'.
           */

          if (nativeAudioContext.state === 'running') {
            this._state = 'suspended';

            const revokeState = () => {
              if (this._state === 'suspended') {
                this._state = null;
              }

              nativeAudioContext.removeEventListener('statechange', revokeState);
            };

            nativeAudioContext.addEventListener('statechange', revokeState);
          }
        }

        get baseLatency() {
          return this._baseLatency;
        }

        get state() {
          return this._state !== null ? this._state : this._nativeAudioContext.state;
        }

        close() {
          // Bug #35: Firefox does not throw an error if the AudioContext was closed before.
          if (this.state === 'closed') {
            return this._nativeAudioContext.close().then(() => {
              throw createInvalidStateError();
            });
          } // Bug #34: If the state was set to suspended before it should be revoked now.


          if (this._state === 'suspended') {
            this._state = null;
          }

          return this._nativeAudioContext.close();
          /*
           * Bug #50: Deleting the AudioGraph is currently not possible anymore.
           * ...then(() => deleteAudioGraph(this, this._nativeAudioContext));
           */
        }

        createMediaElementSource(mediaElement) {
          return new mediaElementAudioSourceNodeConstructor(this, {
            mediaElement
          });
        }

        createMediaStreamDestination() {
          return new mediaStreamAudioDestinationNodeConstructor(this);
        }

        createMediaStreamSource(mediaStream) {
          return new mediaStreamAudioSourceNodeConstructor(this, {
            mediaStream
          });
        }

        createMediaStreamTrackSource(mediaStreamTrack) {
          return new mediaStreamTrackAudioSourceNodeConstructor(this, {
            mediaStreamTrack
          });
        }

        resume() {
          if (this._state === 'suspended') {
            return new Promise((resolve, reject) => {
              const resolvePromise = () => {
                this._nativeAudioContext.removeEventListener('statechange', resolvePromise);

                if (this._nativeAudioContext.state === 'running') {
                  resolve();
                } else {
                  this.resume().then(resolve, reject);
                }
              };

              this._nativeAudioContext.addEventListener('statechange', resolvePromise);
            });
          }

          return this._nativeAudioContext.resume().catch(err => {
            // Bug #55: Chrome, Edge and Opera do throw an InvalidAccessError instead of an InvalidStateError.
            // Bug #56: Safari invokes the catch handler but without an error.
            if (err === undefined || err.code === 15) {
              throw createInvalidStateError();
            }

            throw err;
          });
        }

        suspend() {
          return this._nativeAudioContext.suspend().catch(err => {
            // Bug #56: Safari invokes the catch handler but without an error.
            if (err === undefined) {
              throw createInvalidStateError();
            }

            throw err;
          });
        }

      };
    };

    const createAudioDestinationNodeConstructor = (audioNodeConstructor, createAudioDestinationNodeRenderer, createIndexSizeError, createInvalidStateError, createNativeAudioDestinationNode, getNativeContext, isNativeOfflineAudioContext, renderInputsOfAudioNode) => {
      return class AudioDestinationNode extends audioNodeConstructor {
        constructor(context, channelCount) {
          const nativeContext = getNativeContext(context);
          const isOffline = isNativeOfflineAudioContext(nativeContext);
          const nativeAudioDestinationNode = createNativeAudioDestinationNode(nativeContext, channelCount, isOffline);
          const audioDestinationNodeRenderer = isOffline ? createAudioDestinationNodeRenderer(renderInputsOfAudioNode) : null;
          super(context, false, nativeAudioDestinationNode, audioDestinationNodeRenderer);
          this._isNodeOfNativeOfflineAudioContext = isOffline;
          this._nativeAudioDestinationNode = nativeAudioDestinationNode;
        }

        get channelCount() {
          return this._nativeAudioDestinationNode.channelCount;
        }

        set channelCount(value) {
          // Bug #52: Chrome, Edge, Opera & Safari do not throw an exception at all.
          // Bug #54: Firefox does throw an IndexSizeError.
          if (this._isNodeOfNativeOfflineAudioContext) {
            throw createInvalidStateError();
          } // Bug #47: The AudioDestinationNode in Edge and Safari do not initialize the maxChannelCount property correctly.


          if (value > this._nativeAudioDestinationNode.maxChannelCount) {
            throw createIndexSizeError();
          }

          this._nativeAudioDestinationNode.channelCount = value;
        }

        get channelCountMode() {
          return this._nativeAudioDestinationNode.channelCountMode;
        }

        set channelCountMode(value) {
          // Bug #53: No browser does throw an exception yet.
          if (this._isNodeOfNativeOfflineAudioContext) {
            throw createInvalidStateError();
          }

          this._nativeAudioDestinationNode.channelCountMode = value;
        }

        get maxChannelCount() {
          return this._nativeAudioDestinationNode.maxChannelCount;
        }

      };
    };

    const createAudioDestinationNodeRenderer = renderInputsOfAudioNode => {
      let nativeAudioDestinationNodePromise = null;

      const createAudioDestinationNode = async (proxy, nativeOfflineAudioContext, trace) => {
        const nativeAudioDestinationNode = nativeOfflineAudioContext.destination;
        await renderInputsOfAudioNode(proxy, nativeOfflineAudioContext, nativeAudioDestinationNode, trace);
        return nativeAudioDestinationNode;
      };

      return {
        render(proxy, nativeOfflineAudioContext, trace) {
          if (nativeAudioDestinationNodePromise === null) {
            nativeAudioDestinationNodePromise = createAudioDestinationNode(proxy, nativeOfflineAudioContext, trace);
          }

          return nativeAudioDestinationNodePromise;
        }

      };
    };

    const createAudioListenerFactory = (createAudioParam, createNativeChannelMergerNode, createNativeConstantSourceNode, createNativeScriptProcessorNode, isNativeOfflineAudioContext) => {
      return (context, nativeContext) => {
        const nativeListener = nativeContext.listener; // Bug #117: Only Chrome & Opera support the new interface already.

        const createFakeAudioParams = () => {
          const channelMergerNode = createNativeChannelMergerNode(nativeContext, {
            channelCount: 1,
            channelCountMode: 'explicit',
            channelInterpretation: 'speakers',
            numberOfInputs: 9
          });
          const isOffline = isNativeOfflineAudioContext(nativeContext);
          const scriptProcessorNode = createNativeScriptProcessorNode(nativeContext, 256, 9, 0);

          const createFakeAudioParam = (input, value) => {
            const constantSourceNode = createNativeConstantSourceNode(nativeContext, {
              channelCount: 1,
              channelCountMode: 'explicit',
              channelInterpretation: 'discrete',
              offset: value
            });
            constantSourceNode.connect(channelMergerNode, 0, input); // @todo This should be stopped when the context is closed.

            constantSourceNode.start();
            Object.defineProperty(constantSourceNode.offset, 'defaultValue', {
              get() {
                return value;
              }

            });
            /*
             * Bug #62 & #74: Edge & Safari do not support ConstantSourceNodes and do not export the correct values for maxValue and
             * minValue for GainNodes.
             */

            return createAudioParam({
              context
            }, isOffline, constantSourceNode.offset, MOST_POSITIVE_SINGLE_FLOAT, MOST_NEGATIVE_SINGLE_FLOAT);
          };

          let lastOrientation = [0, 0, -1, 0, 1, 0];
          let lastPosition = [0, 0, 0]; // tslint:disable-next-line:deprecation

          scriptProcessorNode.onaudioprocess = ({
            inputBuffer
          }) => {
            const orientation = [inputBuffer.getChannelData(0)[0], inputBuffer.getChannelData(1)[0], inputBuffer.getChannelData(2)[0], inputBuffer.getChannelData(3)[0], inputBuffer.getChannelData(4)[0], inputBuffer.getChannelData(5)[0]];

            if (orientation.some((value, index) => value !== lastOrientation[index])) {
              nativeListener.setOrientation(...orientation); // tslint:disable-line:deprecation

              lastOrientation = orientation;
            }

            const positon = [inputBuffer.getChannelData(6)[0], inputBuffer.getChannelData(7)[0], inputBuffer.getChannelData(8)[0]];

            if (positon.some((value, index) => value !== lastPosition[index])) {
              nativeListener.setPosition(...positon); // tslint:disable-line:deprecation

              lastPosition = positon;
            }
          };

          channelMergerNode.connect(scriptProcessorNode);
          return {
            forwardX: createFakeAudioParam(0, 0),
            forwardY: createFakeAudioParam(1, 0),
            forwardZ: createFakeAudioParam(2, -1),
            positionX: createFakeAudioParam(6, 0),
            positionY: createFakeAudioParam(7, 0),
            positionZ: createFakeAudioParam(8, 0),
            upX: createFakeAudioParam(3, 0),
            upY: createFakeAudioParam(4, 1),
            upZ: createFakeAudioParam(5, 0)
          };
        };

        const {
          forwardX,
          forwardY,
          forwardZ,
          positionX,
          positionY,
          positionZ,
          upX,
          upY,
          upZ
        } = nativeListener.forwardX === undefined ? createFakeAudioParams() : nativeListener;
        return {
          get forwardX() {
            return forwardX;
          },

          get forwardY() {
            return forwardY;
          },

          get forwardZ() {
            return forwardZ;
          },

          get positionX() {
            return positionX;
          },

          get positionY() {
            return positionY;
          },

          get positionZ() {
            return positionZ;
          },

          get upX() {
            return upX;
          },

          get upY() {
            return upY;
          },

          get upZ() {
            return upZ;
          }

        };
      };
    };

    const isAudioNode = audioNodeOrAudioParam => {
      return 'context' in audioNodeOrAudioParam;
    };

    const isAudioNodeOutputConnection = outputConnection => {
      return isAudioNode(outputConnection[0]);
    };

    const isAudioWorkletNode = audioNode => {
      return 'port' in audioNode;
    };

    const isNativeAudioNodeFaker = nativeAudioNodeOrNativeAudioNodeFaker => {
      return 'inputs' in nativeAudioNodeOrNativeAudioNodeFaker;
    };

    const connectNativeAudioNodeToNativeAudioNode = (nativeSourceAudioNode, nativeDestinationAudioNode, output, input) => {
      if (isNativeAudioNodeFaker(nativeDestinationAudioNode)) {
        const fakeNativeDestinationAudioNode = nativeDestinationAudioNode.inputs[input];
        nativeSourceAudioNode.connect(fakeNativeDestinationAudioNode, output, 0);
        return [fakeNativeDestinationAudioNode, output, 0];
      }

      nativeSourceAudioNode.connect(nativeDestinationAudioNode, output, input);
      return [nativeDestinationAudioNode, output, input];
    };

    const deleteEventListenerOfAudioNode = (audioNode, eventListener) => {
      const eventListeners = getEventListenersOfAudioNode(audioNode);

      if (!eventListeners.delete(eventListener)) {
        throw new Error('Missing the expected event listener.');
      }
    };

    const disconnectNativeAudioNodeFromNativeAudioNode = (nativeSourceAudioNode, nativeDestinationAudioNode, output, input) => {
      if (isNativeAudioNodeFaker(nativeDestinationAudioNode)) {
        nativeSourceAudioNode.disconnect(nativeDestinationAudioNode.inputs[input], output, 0);
      } else {
        nativeSourceAudioNode.disconnect(nativeDestinationAudioNode, output, input);
      }
    };

    const getAudioNodeConnections = audioNode => {
      return getValueForKey(AUDIO_NODE_CONNECTIONS_STORE, audioNode);
    };

    const getAudioParamConnections = audioParam => {
      return getValueForKey(AUDIO_PARAM_CONNECTIONS_STORE, audioParam);
    };

    const getNativeAudioNode = audioNode => {
      return getValueForKey(AUDIO_NODE_STORE, audioNode);
    };

    const getNativeAudioParam = audioParam => {
      return getValueForKey(AUDIO_PARAM_STORE, audioParam);
    };

    const insertElementInSet = (set, element, predicate, ignoreDuplicates) => {
      for (const lmnt of set) {
        if (predicate(lmnt)) {
          if (ignoreDuplicates) {
            return false;
          }

          throw Error('The set contains at least one similar element.');
        }
      }

      set.add(element);
      return true;
    };

    const isActiveAudioNode = audioNode => ACTIVE_AUDIO_NODE_STORE.has(audioNode);

    const isPartOfACycle = audioNode => {
      return CYCLE_COUNTERS.has(audioNode);
    };

    const isPassiveAudioNode = audioNode => {
      return !ACTIVE_AUDIO_NODE_STORE.has(audioNode);
    };

    const pickElementFromSet = (set, predicate) => {
      const matchingElements = Array.from(set).filter(predicate);

      if (matchingElements.length > 1) {
        throw Error('More than one element was found.');
      }

      if (matchingElements.length === 0) {
        throw Error('No element was found.');
      }

      const [matchingElement] = matchingElements;
      set.delete(matchingElement);
      return matchingElement;
    };

    const setInternalStateToPassiveWhenNecessary = (audioNode, activeInputs) => {
      if (!isAudioWorkletNode(audioNode) && activeInputs.every(connections => connections.size === 0)) {
        setInternalStateToPassive(audioNode);
      }
    };

    const testAudioNodeDisconnectMethodSupport = nativeAudioContext => {
      return new Promise(resolve => {
        const analyzer = nativeAudioContext.createScriptProcessor(256, 1, 1);
        const dummy = nativeAudioContext.createGain(); // Bug #95: Safari does not play one sample buffers.

        const ones = nativeAudioContext.createBuffer(1, 2, 44100);
        const channelData = ones.getChannelData(0);
        channelData[0] = 1;
        channelData[1] = 1;
        const source = nativeAudioContext.createBufferSource();
        source.buffer = ones;
        source.loop = true;
        source.connect(analyzer).connect(nativeAudioContext.destination);
        source.connect(dummy);
        source.disconnect(dummy); // tslint:disable-next-line:deprecation

        analyzer.onaudioprocess = event => {
          const chnnlDt = event.inputBuffer.getChannelData(0);

          if (Array.prototype.some.call(chnnlDt, sample => sample === 1)) {
            resolve(true);
          } else {
            resolve(false);
          }

          source.stop();
          analyzer.onaudioprocess = null; // tslint:disable-line:deprecation

          source.disconnect(analyzer);
          analyzer.disconnect(nativeAudioContext.destination);
        };

        source.start();
      });
    };

    const visitEachAudioNodeOnce = (cycles, visitor) => {
      const counts = new Map();

      for (const cycle of cycles) {
        for (const audioNode of cycle) {
          const count = counts.get(audioNode);
          counts.set(audioNode, count === undefined ? 1 : count + 1);
        }
      }

      counts.forEach((count, audioNode) => visitor(audioNode, count));
    };

    const isNativeAudioNode = nativeAudioNodeOrAudioParam => {
      return 'context' in nativeAudioNodeOrAudioParam;
    };

    const wrapAudioNodeDisconnectMethod = nativeAudioNode => {
      const connections = new Map();

      nativeAudioNode.connect = (connect => {
        // tslint:disable-next-line:invalid-void
        return (destination, output = 0, input = 0) => {
          const returnValue = isNativeAudioNode(destination) ? connect(destination, output, input) : connect(destination, output); // Save the new connection only if the calls to connect above didn't throw an error.

          const connectionsToDestination = connections.get(destination);

          if (connectionsToDestination === undefined) {
            connections.set(destination, [{
              input,
              output
            }]);
          } else {
            if (connectionsToDestination.every(connection => connection.input !== input || connection.output !== output)) {
              connectionsToDestination.push({
                input,
                output
              });
            }
          }

          return returnValue;
        };
      })(nativeAudioNode.connect.bind(nativeAudioNode));

      nativeAudioNode.disconnect = (disconnect => {
        return (destinationOrOutput, output, input) => {
          disconnect.apply(nativeAudioNode);

          if (destinationOrOutput === undefined) {
            connections.clear();
          } else if (typeof destinationOrOutput === 'number') {
            for (const [destination, connectionsToDestination] of connections) {
              const filteredConnections = connectionsToDestination.filter(connection => connection.output !== destinationOrOutput);

              if (filteredConnections.length === 0) {
                connections.delete(destination);
              } else {
                connections.set(destination, filteredConnections);
              }
            }
          } else if (connections.has(destinationOrOutput)) {
            if (output === undefined) {
              connections.delete(destinationOrOutput);
            } else {
              const connectionsToDestination = connections.get(destinationOrOutput);

              if (connectionsToDestination !== undefined) {
                const filteredConnections = connectionsToDestination.filter(connection => connection.output !== output && (connection.input !== input || input === undefined));

                if (filteredConnections.length === 0) {
                  connections.delete(destinationOrOutput);
                } else {
                  connections.set(destinationOrOutput, filteredConnections);
                }
              }
            }
          }

          for (const [destination, connectionsToDestination] of connections) {
            connectionsToDestination.forEach(connection => {
              if (isNativeAudioNode(destination)) {
                nativeAudioNode.connect(destination, connection.output, connection.input);
              } else {
                nativeAudioNode.connect(destination, connection.output);
              }
            });
          }
        };
      })(nativeAudioNode.disconnect);
    };

    const addActiveInputConnectionToAudioNode = (activeInputs, source, [output, input, eventListener], ignoreDuplicates) => {
      insertElementInSet(activeInputs[input], [source, output, eventListener], activeInputConnection => activeInputConnection[0] === source && activeInputConnection[1] === output, ignoreDuplicates);
    };

    const addActiveInputConnectionToAudioParam = (activeInputs, source, [output, eventListener], ignoreDuplicates) => {
      insertElementInSet(activeInputs, [source, output, eventListener], activeInputConnection => activeInputConnection[0] === source && activeInputConnection[1] === output, ignoreDuplicates);
    };

    const deleteActiveInputConnectionToAudioNode = (activeInputs, source, output, input) => {
      return pickElementFromSet(activeInputs[input], activeInputConnection => activeInputConnection[0] === source && activeInputConnection[1] === output);
    };

    const deleteActiveInputConnectionToAudioParam = (activeInputs, source, output) => {
      return pickElementFromSet(activeInputs, activeInputConnection => activeInputConnection[0] === source && activeInputConnection[1] === output);
    };

    const addPassiveInputConnectionToAudioNode = (passiveInputs, input, [source, output, eventListener], ignoreDuplicates) => {
      const passiveInputConnections = passiveInputs.get(source);

      if (passiveInputConnections === undefined) {
        passiveInputs.set(source, new Set([[output, input, eventListener]]));
      } else {
        insertElementInSet(passiveInputConnections, [output, input, eventListener], passiveInputConnection => passiveInputConnection[0] === output && passiveInputConnection[1] === input, ignoreDuplicates);
      }
    };

    const addPassiveInputConnectionToAudioParam = (passiveInputs, [source, output, eventListener], ignoreDuplicates) => {
      const passiveInputConnections = passiveInputs.get(source);

      if (passiveInputConnections === undefined) {
        passiveInputs.set(source, new Set([[output, eventListener]]));
      } else {
        insertElementInSet(passiveInputConnections, [output, eventListener], passiveInputConnection => passiveInputConnection[0] === output, ignoreDuplicates);
      }
    };

    const deletePassiveInputConnectionToAudioNode = (passiveInputs, source, output, input) => {
      const passiveInputConnections = getValueForKey(passiveInputs, source);
      const matchingConnection = pickElementFromSet(passiveInputConnections, passiveInputConnection => passiveInputConnection[0] === output && passiveInputConnection[1] === input);

      if (passiveInputConnections.size === 0) {
        passiveInputs.delete(source);
      }

      return matchingConnection;
    };

    const deletePassiveInputConnectionToAudioParam = (passiveInputs, source, output) => {
      const passiveInputConnections = getValueForKey(passiveInputs, source);
      const matchingConnection = pickElementFromSet(passiveInputConnections, passiveInputConnection => passiveInputConnection[0] === output);

      if (passiveInputConnections.size === 0) {
        passiveInputs.delete(source);
      }

      return matchingConnection;
    };

    const addConnectionToAudioNodeOfAudioContext = (source, destination, output, input) => {
      const {
        activeInputs,
        passiveInputs
      } = getAudioNodeConnections(destination);
      const {
        outputs
      } = getAudioNodeConnections(source);
      const eventListeners = getEventListenersOfAudioNode(source);

      const eventListener = isActive => {
        const nativeDestinationAudioNode = getNativeAudioNode(destination);
        const nativeSourceAudioNode = getNativeAudioNode(source);

        if (isActive) {
          const partialConnection = deletePassiveInputConnectionToAudioNode(passiveInputs, source, output, input);
          addActiveInputConnectionToAudioNode(activeInputs, source, partialConnection, false);

          if (!isPartOfACycle(source)) {
            connectNativeAudioNodeToNativeAudioNode(nativeSourceAudioNode, nativeDestinationAudioNode, output, input);
          }

          if (isPassiveAudioNode(destination)) {
            setInternalStateToActive(destination);
          }
        } else {
          const partialConnection = deleteActiveInputConnectionToAudioNode(activeInputs, source, output, input);
          addPassiveInputConnectionToAudioNode(passiveInputs, input, partialConnection, false);

          if (!isPartOfACycle(source)) {
            disconnectNativeAudioNodeFromNativeAudioNode(nativeSourceAudioNode, nativeDestinationAudioNode, output, input);
          }

          if (isActiveAudioNode(destination)) {
            setInternalStateToPassiveWhenNecessary(destination, activeInputs);
          }
        }
      };

      if (insertElementInSet(outputs, [destination, output, input], outputConnection => outputConnection[0] === destination && outputConnection[1] === output && outputConnection[2] === input, true)) {
        eventListeners.add(eventListener);

        if (isActiveAudioNode(source)) {
          addActiveInputConnectionToAudioNode(activeInputs, source, [output, input, eventListener], true);
        } else {
          addPassiveInputConnectionToAudioNode(passiveInputs, input, [source, output, eventListener], true);
        }

        return true;
      }

      return false;
    };

    const addConnectionToAudioNodeOfOfflineAudioContext = (source, destination, output, input) => {
      const {
        outputs
      } = getAudioNodeConnections(source);

      if (insertElementInSet(outputs, [destination, output, input], outputConnection => outputConnection[0] === destination && outputConnection[1] === output && outputConnection[2] === input, true)) {
        const {
          activeInputs
        } = getAudioNodeConnections(destination);
        addActiveInputConnectionToAudioNode(activeInputs, source, [output, input, null], true);
        return true;
      }

      return false;
    };

    const addConnectionToAudioParamOfAudioContext = (source, destination, output) => {
      const {
        activeInputs,
        passiveInputs
      } = getAudioParamConnections(destination);
      const {
        outputs
      } = getAudioNodeConnections(source);
      const eventListeners = getEventListenersOfAudioNode(source);

      const eventListener = isActive => {
        const nativeAudioNode = getNativeAudioNode(source);
        const nativeAudioParam = getNativeAudioParam(destination);

        if (isActive) {
          const partialConnection = deletePassiveInputConnectionToAudioParam(passiveInputs, source, output);
          addActiveInputConnectionToAudioParam(activeInputs, source, partialConnection, false);

          if (!isPartOfACycle(source)) {
            nativeAudioNode.connect(nativeAudioParam, output);
          }
        } else {
          const partialConnection = deleteActiveInputConnectionToAudioParam(activeInputs, source, output);
          addPassiveInputConnectionToAudioParam(passiveInputs, partialConnection, false);

          if (!isPartOfACycle(source)) {
            nativeAudioNode.disconnect(nativeAudioParam, output);
          }
        }
      };

      if (insertElementInSet(outputs, [destination, output], outputConnection => outputConnection[0] === destination && outputConnection[1] === output, true)) {
        eventListeners.add(eventListener);

        if (isActiveAudioNode(source)) {
          addActiveInputConnectionToAudioParam(activeInputs, source, [output, eventListener], true);
        } else {
          addPassiveInputConnectionToAudioParam(passiveInputs, [source, output, eventListener], true);
        }

        return true;
      }

      return false;
    };

    const addConnectionToAudioParamOfOfflineAudioContext = (source, destination, output) => {
      const {
        outputs
      } = getAudioNodeConnections(source);

      if (insertElementInSet(outputs, [destination, output], outputConnection => outputConnection[0] === destination && outputConnection[1] === output, true)) {
        const {
          activeInputs
        } = getAudioParamConnections(destination);
        addActiveInputConnectionToAudioParam(activeInputs, source, [output, null], true);
        return true;
      }

      return false;
    };

    const deleteActiveInputConnection = (activeInputConnections, source, output) => {
      for (const activeInputConnection of activeInputConnections) {
        if (activeInputConnection[0] === source && activeInputConnection[1] === output) {
          activeInputConnections.delete(activeInputConnection);
          return activeInputConnection;
        }
      }

      return null;
    };

    const deleteInputConnectionOfAudioNode = (source, destination, output, input) => {
      const {
        activeInputs,
        passiveInputs
      } = getAudioNodeConnections(destination);
      const activeInputConnection = deleteActiveInputConnection(activeInputs[input], source, output);

      if (activeInputConnection === null) {
        const passiveInputConnection = deletePassiveInputConnectionToAudioNode(passiveInputs, source, output, input);
        return [passiveInputConnection[2], false];
      }

      return [activeInputConnection[2], true];
    };

    const deleteInputConnectionOfAudioParam = (source, destination, output) => {
      const {
        activeInputs,
        passiveInputs
      } = getAudioParamConnections(destination);
      const activeInputConnection = deleteActiveInputConnection(activeInputs, source, output);

      if (activeInputConnection === null) {
        const passiveInputConnection = deletePassiveInputConnectionToAudioParam(passiveInputs, source, output);
        return [passiveInputConnection[1], false];
      }

      return [activeInputConnection[2], true];
    };

    const deleteInputsOfAudioNode = (source, destination, output, input) => {
      const [listener, isActive] = deleteInputConnectionOfAudioNode(source, destination, output, input);

      if (listener !== null) {
        deleteEventListenerOfAudioNode(source, listener);

        if (isActive && !isPartOfACycle(source)) {
          disconnectNativeAudioNodeFromNativeAudioNode(getNativeAudioNode(source), getNativeAudioNode(destination), output, input);
        }
      }

      if (isActiveAudioNode(destination)) {
        const {
          activeInputs
        } = getAudioNodeConnections(destination);
        setInternalStateToPassiveWhenNecessary(destination, activeInputs);
      }
    };

    const deleteInputsOfAudioParam = (source, destination, output) => {
      const [listener, isActive] = deleteInputConnectionOfAudioParam(source, destination, output);

      if (listener !== null) {
        deleteEventListenerOfAudioNode(source, listener);

        if (isActive && !isPartOfACycle(source)) {
          getNativeAudioNode(source).disconnect(getNativeAudioParam(destination), output);
        }
      }
    };

    const deleteAnyConnection = source => {
      const audioNodeConnectionsOfSource = getAudioNodeConnections(source);
      const destinations = [];

      for (const outputConnection of audioNodeConnectionsOfSource.outputs) {
        if (isAudioNodeOutputConnection(outputConnection)) {
          deleteInputsOfAudioNode(source, ...outputConnection);
        } else {
          deleteInputsOfAudioParam(source, ...outputConnection);
        }

        destinations.push(outputConnection[0]);
      }

      audioNodeConnectionsOfSource.outputs.clear();
      return destinations;
    };

    const deleteConnectionAtOutput = (source, output) => {
      const audioNodeConnectionsOfSource = getAudioNodeConnections(source);
      const destinations = [];

      for (const outputConnection of audioNodeConnectionsOfSource.outputs) {
        if (outputConnection[1] === output) {
          if (isAudioNodeOutputConnection(outputConnection)) {
            deleteInputsOfAudioNode(source, ...outputConnection);
          } else {
            deleteInputsOfAudioParam(source, ...outputConnection);
          }

          destinations.push(outputConnection[0]);
          audioNodeConnectionsOfSource.outputs.delete(outputConnection);
        }
      }

      return destinations;
    };

    const deleteConnectionToDestination = (source, destination, output, input) => {
      const audioNodeConnectionsOfSource = getAudioNodeConnections(source);
      return Array.from(audioNodeConnectionsOfSource.outputs).filter(outputConnection => outputConnection[0] === destination && (output === undefined || outputConnection[1] === output) && (input === undefined || outputConnection[2] === input)).map(outputConnection => {
        if (isAudioNodeOutputConnection(outputConnection)) {
          deleteInputsOfAudioNode(source, ...outputConnection);
        } else {
          deleteInputsOfAudioParam(source, ...outputConnection);
        }

        audioNodeConnectionsOfSource.outputs.delete(outputConnection);
        return outputConnection[0];
      });
    };

    const createAudioNodeConstructor = (addAudioNodeConnections, auxiliaryGainNodeStore, cacheTestResult, createIncrementCycleCounter, createIndexSizeError, createInvalidAccessError, createNotSupportedError, decrementCycleCounter, detectCycles, eventTargetConstructor, getNativeContext, isNativeAudioContext, isNativeAudioNode, isNativeAudioParam, isNativeOfflineAudioContext) => {
      return class AudioNode extends eventTargetConstructor {
        constructor(context, isActive, nativeAudioNode, audioNodeRenderer) {
          super(nativeAudioNode);
          this._context = context;
          this._nativeAudioNode = nativeAudioNode;
          const nativeContext = getNativeContext(context); // Bug #12: Safari does not support to disconnect a specific destination.

          if (isNativeAudioContext(nativeContext) && true !== cacheTestResult(testAudioNodeDisconnectMethodSupport, () => {
            return testAudioNodeDisconnectMethodSupport(nativeContext);
          })) {
            wrapAudioNodeDisconnectMethod(nativeAudioNode);
          }

          AUDIO_NODE_STORE.set(this, nativeAudioNode);
          EVENT_LISTENERS.set(this, new Set());

          if (isActive) {
            setInternalStateToActive(this);
          }

          addAudioNodeConnections(this, audioNodeRenderer, nativeAudioNode);
        }

        get channelCount() {
          return this._nativeAudioNode.channelCount;
        }

        set channelCount(value) {
          this._nativeAudioNode.channelCount = value;
        }

        get channelCountMode() {
          return this._nativeAudioNode.channelCountMode;
        }

        set channelCountMode(value) {
          this._nativeAudioNode.channelCountMode = value;
        }

        get channelInterpretation() {
          return this._nativeAudioNode.channelInterpretation;
        }

        set channelInterpretation(value) {
          this._nativeAudioNode.channelInterpretation = value;
        }

        get context() {
          return this._context;
        }

        get numberOfInputs() {
          return this._nativeAudioNode.numberOfInputs;
        }

        get numberOfOutputs() {
          return this._nativeAudioNode.numberOfOutputs;
        } // tslint:disable-next-line:invalid-void


        connect(destination, output = 0, input = 0) {
          // Bug #174: Safari does expose a wrong numberOfOutputs for MediaStreamAudioDestinationNodes.
          if (output < 0 || output >= this._nativeAudioNode.numberOfOutputs) {
            throw createIndexSizeError();
          }

          const nativeContext = getNativeContext(this._context);
          const isOffline = isNativeOfflineAudioContext(nativeContext);

          if (isNativeAudioNode(destination) || isNativeAudioParam(destination)) {
            throw createInvalidAccessError();
          }

          if (isAudioNode(destination)) {
            const nativeDestinationAudioNode = getNativeAudioNode(destination);

            try {
              const connection = connectNativeAudioNodeToNativeAudioNode(this._nativeAudioNode, nativeDestinationAudioNode, output, input);

              if (isOffline || isPassiveAudioNode(this)) {
                this._nativeAudioNode.disconnect(...connection);
              } else if (isPassiveAudioNode(destination)) {
                setInternalStateToActive(destination);
              } // An AudioWorklet needs a connection because it otherwise may truncate the input array.
              // @todo Count the number of connections which depend on this auxiliary GainNode to know when it can be removed again.


              if (isAudioWorkletNode(destination)) {
                const auxiliaryGainNodes = auxiliaryGainNodeStore.get(nativeDestinationAudioNode);

                if (auxiliaryGainNodes === undefined) {
                  const nativeGainNode = nativeContext.createGain();
                  nativeGainNode.connect(connection[0], 0, connection[2]);
                  auxiliaryGainNodeStore.set(nativeDestinationAudioNode, new Map([[input, nativeGainNode]]));
                } else if (auxiliaryGainNodes.get(input) === undefined) {
                  const nativeGainNode = nativeContext.createGain();
                  nativeGainNode.connect(connection[0], 0, connection[2]);
                  auxiliaryGainNodes.set(input, nativeGainNode);
                }
              }
            } catch (err) {
              // Bug #41: Only Chrome, Firefox and Opera throw the correct exception by now.
              if (err.code === 12) {
                throw createInvalidAccessError();
              }

              throw err;
            }

            const isNewConnectionToAudioNode = isOffline ? addConnectionToAudioNodeOfOfflineAudioContext(this, destination, output, input) : addConnectionToAudioNodeOfAudioContext(this, destination, output, input); // Bug #164: Only Firefox detects cycles so far.

            if (isNewConnectionToAudioNode) {
              const cycles = detectCycles([this], destination);
              visitEachAudioNodeOnce(cycles, createIncrementCycleCounter(isOffline));
            }

            return destination;
          }

          const nativeAudioParam = getNativeAudioParam(destination);
          /*
           * Bug #147 & #153: Safari does not support to connect an input signal to the playbackRate AudioParam of an
           * AudioBufferSourceNode. This can't be easily detected and that's why the outdated name property is used here to identify
           * Safari.
           */

          if (nativeAudioParam.name === 'playbackRate') {
            throw createNotSupportedError();
          }

          try {
            this._nativeAudioNode.connect(nativeAudioParam, output);

            if (isOffline || isPassiveAudioNode(this)) {
              this._nativeAudioNode.disconnect(nativeAudioParam, output);
            }
          } catch (err) {
            // Bug #58: Only Firefox does throw an InvalidStateError yet.
            if (err.code === 12) {
              throw createInvalidAccessError();
            }

            throw err;
          }

          const isNewConnectionToAudioParam = isOffline ? addConnectionToAudioParamOfOfflineAudioContext(this, destination, output) : addConnectionToAudioParamOfAudioContext(this, destination, output); // Bug #164: Only Firefox detects cycles so far.

          if (isNewConnectionToAudioParam) {
            const cycles = detectCycles([this], destination);
            visitEachAudioNodeOnce(cycles, createIncrementCycleCounter(isOffline));
          }
        }

        disconnect(destinationOrOutput, output, input) {
          let destinations;

          if (destinationOrOutput === undefined) {
            destinations = deleteAnyConnection(this);
          } else if (typeof destinationOrOutput === 'number') {
            if (destinationOrOutput < 0 || destinationOrOutput >= this.numberOfOutputs) {
              throw createIndexSizeError();
            }

            destinations = deleteConnectionAtOutput(this, destinationOrOutput);
          } else {
            if (output !== undefined && (output < 0 || output >= this.numberOfOutputs)) {
              throw createIndexSizeError();
            }

            if (isAudioNode(destinationOrOutput) && input !== undefined && (input < 0 || input >= destinationOrOutput.numberOfInputs)) {
              throw createIndexSizeError();
            }

            destinations = deleteConnectionToDestination(this, destinationOrOutput, output, input);

            if (destinations.length === 0) {
              throw createInvalidAccessError();
            }
          } // Bug #164: Only Firefox detects cycles so far.


          for (const destination of destinations) {
            const cycles = detectCycles([this], destination);
            visitEachAudioNodeOnce(cycles, decrementCycleCounter);
          }
        }

      };
    };

    const createAudioParamFactory = (addAudioParamConnections, audioParamAudioNodeStore, audioParamStore, createAudioParamRenderer, createCancelAndHoldAutomationEvent, createCancelScheduledValuesAutomationEvent, createExponentialRampToValueAutomationEvent, createLinearRampToValueAutomationEvent, createSetTargetAutomationEvent, createSetValueAutomationEvent, createSetValueCurveAutomationEvent, nativeAudioContextConstructor) => {
      return (audioNode, isAudioParamOfOfflineAudioContext, nativeAudioParam, maxValue = null, minValue = null) => {
        const automationEventList = new automationEvents.AutomationEventList(nativeAudioParam.defaultValue);
        const audioParamRenderer = isAudioParamOfOfflineAudioContext ? createAudioParamRenderer(automationEventList) : null;
        const audioParam = {
          get defaultValue() {
            return nativeAudioParam.defaultValue;
          },

          get maxValue() {
            return maxValue === null ? nativeAudioParam.maxValue : maxValue;
          },

          get minValue() {
            return minValue === null ? nativeAudioParam.minValue : minValue;
          },

          get value() {
            return nativeAudioParam.value;
          },

          set value(value) {
            nativeAudioParam.value = value; // Bug #98: Edge, Firefox & Safari do not yet treat the value setter like a call to setValueAtTime().

            audioParam.setValueAtTime(value, audioNode.context.currentTime);
          },

          cancelAndHoldAtTime(cancelTime) {
            // Bug #28: Edge, Firefox & Safari do not yet implement cancelAndHoldAtTime().
            if (typeof nativeAudioParam.cancelAndHoldAtTime === 'function') {
              if (audioParamRenderer === null) {
                automationEventList.flush(audioNode.context.currentTime);
              }

              automationEventList.add(createCancelAndHoldAutomationEvent(cancelTime));
              nativeAudioParam.cancelAndHoldAtTime(cancelTime);
            } else {
              const previousLastEvent = Array.from(automationEventList).pop();

              if (audioParamRenderer === null) {
                automationEventList.flush(audioNode.context.currentTime);
              }

              automationEventList.add(createCancelAndHoldAutomationEvent(cancelTime));
              const currentLastEvent = Array.from(automationEventList).pop();
              nativeAudioParam.cancelScheduledValues(cancelTime);

              if (previousLastEvent !== currentLastEvent && currentLastEvent !== undefined) {
                if (currentLastEvent.type === 'exponentialRampToValue') {
                  nativeAudioParam.exponentialRampToValueAtTime(currentLastEvent.value, currentLastEvent.endTime);
                } else if (currentLastEvent.type === 'linearRampToValue') {
                  nativeAudioParam.linearRampToValueAtTime(currentLastEvent.value, currentLastEvent.endTime);
                } else if (currentLastEvent.type === 'setValue') {
                  nativeAudioParam.setValueAtTime(currentLastEvent.value, currentLastEvent.startTime);
                } else if (currentLastEvent.type === 'setValueCurve') {
                  nativeAudioParam.setValueCurveAtTime(currentLastEvent.values, currentLastEvent.startTime, currentLastEvent.duration);
                }
              }
            }

            return audioParam;
          },

          cancelScheduledValues(cancelTime) {
            if (audioParamRenderer === null) {
              automationEventList.flush(audioNode.context.currentTime);
            }

            automationEventList.add(createCancelScheduledValuesAutomationEvent(cancelTime));
            nativeAudioParam.cancelScheduledValues(cancelTime);
            return audioParam;
          },

          exponentialRampToValueAtTime(value, endTime) {
            if (audioParamRenderer === null) {
              automationEventList.flush(audioNode.context.currentTime);
            }

            automationEventList.add(createExponentialRampToValueAutomationEvent(value, endTime));
            nativeAudioParam.exponentialRampToValueAtTime(value, endTime);
            return audioParam;
          },

          linearRampToValueAtTime(value, endTime) {
            if (audioParamRenderer === null) {
              automationEventList.flush(audioNode.context.currentTime);
            }

            automationEventList.add(createLinearRampToValueAutomationEvent(value, endTime));
            nativeAudioParam.linearRampToValueAtTime(value, endTime);
            return audioParam;
          },

          setTargetAtTime(target, startTime, timeConstant) {
            if (audioParamRenderer === null) {
              automationEventList.flush(audioNode.context.currentTime);
            }

            automationEventList.add(createSetTargetAutomationEvent(target, startTime, timeConstant));
            nativeAudioParam.setTargetAtTime(target, startTime, timeConstant);
            return audioParam;
          },

          setValueAtTime(value, startTime) {
            if (audioParamRenderer === null) {
              automationEventList.flush(audioNode.context.currentTime);
            }

            automationEventList.add(createSetValueAutomationEvent(value, startTime));
            nativeAudioParam.setValueAtTime(value, startTime);
            return audioParam;
          },

          setValueCurveAtTime(values, startTime, duration) {
            /*
             * Bug #152: Safari does not correctly interpolate the values of the curve.
             * @todo Unfortunately there is no way to test for this behavior in synchronous fashion which is why testing for the
             * existence of the webkitAudioContext is used as a workaround here.
             */
            if (nativeAudioContextConstructor !== null && nativeAudioContextConstructor.name === 'webkitAudioContext') {
              const endTime = startTime + duration;
              const sampleRate = audioNode.context.sampleRate;
              const firstSample = Math.ceil(startTime * sampleRate);
              const lastSample = Math.floor(endTime * sampleRate);
              const numberOfInterpolatedValues = lastSample - firstSample;
              const interpolatedValues = new Float32Array(numberOfInterpolatedValues);

              for (let i = 0; i < numberOfInterpolatedValues; i += 1) {
                const theoreticIndex = (values.length - 1) / duration * ((firstSample + i) / sampleRate - startTime);
                const lowerIndex = Math.floor(theoreticIndex);
                const upperIndex = Math.ceil(theoreticIndex);
                interpolatedValues[i] = lowerIndex === upperIndex ? values[lowerIndex] : (1 - (theoreticIndex - lowerIndex)) * values[lowerIndex] + (1 - (upperIndex - theoreticIndex)) * values[upperIndex];
              }

              if (audioParamRenderer === null) {
                automationEventList.flush(audioNode.context.currentTime);
              }

              automationEventList.add(createSetValueCurveAutomationEvent(interpolatedValues, startTime, duration));
              nativeAudioParam.setValueCurveAtTime(interpolatedValues, startTime, duration);
              const timeOfLastSample = lastSample / sampleRate;

              if (timeOfLastSample < endTime) {
                audioParam.setValueAtTime(interpolatedValues[interpolatedValues.length - 1], timeOfLastSample);
              }

              audioParam.setValueAtTime(values[values.length - 1], endTime);
            } else {
              if (audioParamRenderer === null) {
                automationEventList.flush(audioNode.context.currentTime);
              }

              automationEventList.add(createSetValueCurveAutomationEvent(values, startTime, duration));
              nativeAudioParam.setValueCurveAtTime(values, startTime, duration);
            }

            return audioParam;
          }

        };
        audioParamStore.set(audioParam, nativeAudioParam);
        audioParamAudioNodeStore.set(audioParam, audioNode);
        addAudioParamConnections(audioParam, audioParamRenderer);
        return audioParam;
      };
    };

    const createAudioParamRenderer = automationEventList => {
      return {
        replay(audioParam) {
          for (const automationEvent of automationEventList) {
            if (automationEvent.type === 'exponentialRampToValue') {
              const {
                endTime,
                value
              } = automationEvent;
              audioParam.exponentialRampToValueAtTime(value, endTime);
            } else if (automationEvent.type === 'linearRampToValue') {
              const {
                endTime,
                value
              } = automationEvent;
              audioParam.linearRampToValueAtTime(value, endTime);
            } else if (automationEvent.type === 'setTarget') {
              const {
                startTime,
                target,
                timeConstant
              } = automationEvent;
              audioParam.setTargetAtTime(target, startTime, timeConstant);
            } else if (automationEvent.type === 'setValue') {
              const {
                startTime,
                value
              } = automationEvent;
              audioParam.setValueAtTime(value, startTime);
            } else if (automationEvent.type === 'setValueCurve') {
              const {
                duration,
                startTime,
                values
              } = automationEvent;
              audioParam.setValueCurveAtTime(values, startTime, duration);
            } else {
              throw new Error("Can't apply an unknown automation.");
            }
          }
        }

      };
    };

    class ReadOnlyMap {
      constructor(parameters) {
        this._map = new Map(parameters);
      }

      get size() {
        return this._map.size;
      }

      entries() {
        return this._map.entries();
      }

      forEach(callback, thisArg = null) {
        return this._map.forEach((value, key) => callback.call(thisArg, value, key, this));
      }

      get(name) {
        return this._map.get(name);
      }

      has(name) {
        return this._map.has(name);
      }

      keys() {
        return this._map.keys();
      }

      values() {
        return this._map.values();
      }

    }

    const DEFAULT_OPTIONS$3 = {
      channelCount: 2,
      // Bug #61: The channelCountMode should be 'max' according to the spec but is set to 'explicit' to achieve consistent behavior.
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: undefined,
      parameterData: {},
      processorOptions: {}
    };

    const createChannelCount = length => {
      const channelCount = [];

      for (let i = 0; i < length; i += 1) {
        channelCount.push(1);
      }

      return channelCount;
    };

    const sanitizedOptions = options => {
      return { ...options,
        outputChannelCount: options.outputChannelCount !== undefined ? options.outputChannelCount : options.numberOfInputs === 1 && options.numberOfOutputs === 1 ?
        /*
         * Bug #61: This should be the computedNumberOfChannels, but unfortunately that is almost impossible to fake. That's why
         * the channelCountMode is required to be 'explicit' as long as there is not a native implementation in every browser. That
         * makes sure the computedNumberOfChannels is equivilant to the channelCount which makes it much easier to compute.
         */
        [options.channelCount] : createChannelCount(options.numberOfOutputs)
      };
    };

    const createAudioWorkletNodeConstructor = (addUnrenderedAudioWorkletNode, audioNodeConstructor, createAudioParam, createAudioWorkletNodeRenderer, createNativeAudioWorkletNode, getNativeContext, isNativeOfflineAudioContext, nativeAudioWorkletNodeConstructor, wrapEventListener) => {
      return class AudioWorkletNode extends audioNodeConstructor {
        constructor(context, name, options = DEFAULT_OPTIONS$3) {
          const nativeContext = getNativeContext(context);
          const isOffline = isNativeOfflineAudioContext(nativeContext);
          const mergedOptions = sanitizedOptions({ ...DEFAULT_OPTIONS$3,
            ...options
          });
          const nodeNameToProcessorConstructorMap = NODE_NAME_TO_PROCESSOR_CONSTRUCTOR_MAPS.get(nativeContext);
          const processorConstructor = nodeNameToProcessorConstructorMap === undefined ? undefined : nodeNameToProcessorConstructorMap.get(name);
          const nativeAudioWorkletNode = createNativeAudioWorkletNode(nativeContext, isOffline ? null : context.baseLatency, nativeAudioWorkletNodeConstructor, name, processorConstructor, mergedOptions);
          const audioWorkletNodeRenderer = isOffline ? createAudioWorkletNodeRenderer(name, mergedOptions, processorConstructor) : null;
          /*
           * @todo Add a mechanism to switch an AudioWorkletNode to passive once the process() function of the AudioWorkletProcessor
           * returns false.
           */

          super(context, true, nativeAudioWorkletNode, audioWorkletNodeRenderer);
          const parameters = [];
          nativeAudioWorkletNode.parameters.forEach((nativeAudioParam, nm) => {
            const audioParam = createAudioParam(this, isOffline, nativeAudioParam);
            parameters.push([nm, audioParam]);
          });
          this._nativeAudioWorkletNode = nativeAudioWorkletNode;
          this._onprocessorerror = null;
          this._parameters = new ReadOnlyMap(parameters);
          /*
           * Bug #86 & #87: Invoking the renderer of an AudioWorkletNode might be necessary if it has no direct or indirect connection to
           * the destination.
           */

          if (isOffline) {
            addUnrenderedAudioWorkletNode(nativeContext, this);
          }
        }

        get onprocessorerror() {
          return this._onprocessorerror;
        }

        set onprocessorerror(value) {
          const wrappedListener = typeof value === 'function' ? wrapEventListener(this, value) : null;
          this._nativeAudioWorkletNode.onprocessorerror = wrappedListener;
          const nativeOnProcessorError = this._nativeAudioWorkletNode.onprocessorerror;
          this._onprocessorerror = nativeOnProcessorError !== null && nativeOnProcessorError === wrappedListener ? value : nativeOnProcessorError;
        }

        get parameters() {
          if (this._parameters === null) {
            // @todo The definition that TypeScript uses of the AudioParamMap is lacking many methods.
            return this._nativeAudioWorkletNode.parameters;
          }

          return this._parameters;
        }

        get port() {
          return this._nativeAudioWorkletNode.port;
        }

      };
    };

    function copyFromChannel(audioBuffer, // @todo There is currently no way to define something like { [ key: number | string ]: Float32Array }
    parent, key, channelNumber, bufferOffset) {
      if (typeof audioBuffer.copyFromChannel === 'function') {
        // The byteLength will be 0 when the ArrayBuffer was transferred.
        if (parent[key].byteLength === 0) {
          parent[key] = new Float32Array(128);
        }

        audioBuffer.copyFromChannel(parent[key], channelNumber, bufferOffset); // Bug #5: Safari does not support copyFromChannel().
      } else {
        const channelData = audioBuffer.getChannelData(channelNumber); // The byteLength will be 0 when the ArrayBuffer was transferred.

        if (parent[key].byteLength === 0) {
          parent[key] = channelData.slice(bufferOffset, bufferOffset + 128);
        } else {
          const slicedInput = new Float32Array(channelData.buffer, bufferOffset * Float32Array.BYTES_PER_ELEMENT, 128);
          parent[key].set(slicedInput);
        }
      }
    }

    const copyToChannel = (audioBuffer, parent, key, channelNumber, bufferOffset) => {
      if (typeof audioBuffer.copyToChannel === 'function') {
        // The byteLength will be 0 when the ArrayBuffer was transferred.
        if (parent[key].byteLength !== 0) {
          audioBuffer.copyToChannel(parent[key], channelNumber, bufferOffset);
        } // Bug #5: Safari does not support copyToChannel().

      } else {
        // The byteLength will be 0 when the ArrayBuffer was transferred.
        if (parent[key].byteLength !== 0) {
          audioBuffer.getChannelData(channelNumber).set(parent[key], bufferOffset);
        }
      }
    };

    const createNestedArrays = (x, y) => {
      const arrays = [];

      for (let i = 0; i < x; i += 1) {
        const array = [];
        const length = typeof y === 'number' ? y : y[i];

        for (let j = 0; j < length; j += 1) {
          array.push(new Float32Array(128));
        }

        arrays.push(array);
      }

      return arrays;
    };

    const getAudioWorkletProcessor = (nativeOfflineAudioContext, proxy) => {
      const nodeToProcessorMap = getValueForKey(NODE_TO_PROCESSOR_MAPS, nativeOfflineAudioContext);
      const nativeAudioWorkletNode = getNativeAudioNode(proxy);
      return getValueForKey(nodeToProcessorMap, nativeAudioWorkletNode);
    };

    const processBuffer = async (proxy, renderedBuffer, nativeOfflineAudioContext, options, processorConstructor, exposeCurrentFrameAndCurrentTime) => {
      // Ceil the length to the next full render quantum.
      // Bug #17: Safari does not yet expose the length.
      const length = renderedBuffer === null ? Math.ceil(proxy.context.length / 128) * 128 : renderedBuffer.length;
      const numberOfInputChannels = options.channelCount * options.numberOfInputs;
      const numberOfOutputChannels = options.outputChannelCount.reduce((sum, value) => sum + value, 0);
      const processedBuffer = numberOfOutputChannels === 0 ? null : nativeOfflineAudioContext.createBuffer(numberOfOutputChannels, length, nativeOfflineAudioContext.sampleRate);

      if (processorConstructor === undefined) {
        throw new Error('Missing the processor constructor.');
      }

      const audioNodeConnections = getAudioNodeConnections(proxy);
      const audioWorkletProcessor = await getAudioWorkletProcessor(nativeOfflineAudioContext, proxy);
      const inputs = createNestedArrays(options.numberOfInputs, options.channelCount);
      const outputs = createNestedArrays(options.numberOfOutputs, options.outputChannelCount);
      const parameters = Array.from(proxy.parameters.keys()).reduce((prmtrs, name) => ({ ...prmtrs,
        [name]: new Float32Array(128)
      }), {});

      for (let i = 0; i < length; i += 128) {
        if (options.numberOfInputs > 0 && renderedBuffer !== null) {
          for (let j = 0; j < options.numberOfInputs; j += 1) {
            for (let k = 0; k < options.channelCount; k += 1) {
              copyFromChannel(renderedBuffer, inputs[j], k, k, i);
            }
          }
        }

        if (processorConstructor.parameterDescriptors !== undefined && renderedBuffer !== null) {
          processorConstructor.parameterDescriptors.forEach(({
            name
          }, index) => {
            copyFromChannel(renderedBuffer, parameters, name, numberOfInputChannels + index, i);
          });
        }

        for (let j = 0; j < options.numberOfInputs; j += 1) {
          for (let k = 0; k < options.outputChannelCount[j]; k += 1) {
            // The byteLength will be 0 when the ArrayBuffer was transferred.
            if (outputs[j][k].byteLength === 0) {
              outputs[j][k] = new Float32Array(128);
            }
          }
        }

        try {
          const potentiallyEmptyInputs = inputs.map((input, index) => {
            if (audioNodeConnections.activeInputs[index].size === 0) {
              return [];
            }

            return input;
          });
          const activeSourceFlag = exposeCurrentFrameAndCurrentTime(i / nativeOfflineAudioContext.sampleRate, nativeOfflineAudioContext.sampleRate, () => audioWorkletProcessor.process(potentiallyEmptyInputs, outputs, parameters));

          if (processedBuffer !== null) {
            for (let j = 0, outputChannelSplitterNodeOutput = 0; j < options.numberOfOutputs; j += 1) {
              for (let k = 0; k < options.outputChannelCount[j]; k += 1) {
                copyToChannel(processedBuffer, outputs[j], k, outputChannelSplitterNodeOutput + k, i);
              }

              outputChannelSplitterNodeOutput += options.outputChannelCount[j];
            }
          }

          if (!activeSourceFlag) {
            break;
          }
        } catch (error) {
          proxy.dispatchEvent(new ErrorEvent('processorerror', {
            error
          }));
          break;
        }
      }

      return processedBuffer;
    };

    const createAudioWorkletNodeRendererFactory = (connectAudioParam, connectMultipleOutputs, createNativeAudioBufferSourceNode, createNativeChannelMergerNode, createNativeChannelSplitterNode, createNativeConstantSourceNode, createNativeGainNode, deleteUnrenderedAudioWorkletNode, disconnectMultipleOutputs, exposeCurrentFrameAndCurrentTime, getNativeAudioNode, nativeAudioWorkletNodeConstructor, nativeOfflineAudioContextConstructor, renderAutomation, renderInputsOfAudioNode, renderNativeOfflineAudioContext) => {
      return (name, options, processorConstructor) => {
        const renderedNativeAudioNodes = new WeakMap();
        let processedBufferPromise = null;

        const createAudioNode = async (proxy, nativeOfflineAudioContext, trace) => {
          let nativeAudioWorkletNode = getNativeAudioNode(proxy);
          let nativeOutputNodes = null;
          const nativeAudioWorkletNodeIsOwnedByContext = isOwnedByContext(nativeAudioWorkletNode, nativeOfflineAudioContext); // Bug #61: Only Chrome & Opera have an implementation of the AudioWorkletNode yet.

          if (nativeAudioWorkletNodeConstructor === null) {
            const numberOfOutputChannels = options.outputChannelCount.reduce((sum, value) => sum + value, 0);
            const outputChannelSplitterNode = createNativeChannelSplitterNode(nativeOfflineAudioContext, {
              channelCount: Math.max(1, numberOfOutputChannels),
              channelCountMode: 'explicit',
              channelInterpretation: 'discrete',
              numberOfOutputs: Math.max(1, numberOfOutputChannels)
            });
            const outputChannelMergerNodes = [];

            for (let i = 0; i < proxy.numberOfOutputs; i += 1) {
              outputChannelMergerNodes.push(createNativeChannelMergerNode(nativeOfflineAudioContext, {
                channelCount: 1,
                channelCountMode: 'explicit',
                channelInterpretation: 'speakers',
                numberOfInputs: options.outputChannelCount[i]
              }));
            }

            const outputGainNode = createNativeGainNode(nativeOfflineAudioContext, {
              channelCount: options.channelCount,
              channelCountMode: options.channelCountMode,
              channelInterpretation: options.channelInterpretation,
              gain: 1
            });
            outputGainNode.connect = connectMultipleOutputs.bind(null, outputChannelMergerNodes);
            outputGainNode.disconnect = disconnectMultipleOutputs.bind(null, outputChannelMergerNodes);
            nativeOutputNodes = [outputChannelSplitterNode, outputChannelMergerNodes, outputGainNode];
          } else if (!nativeAudioWorkletNodeIsOwnedByContext) {
            nativeAudioWorkletNode = new nativeAudioWorkletNodeConstructor(nativeOfflineAudioContext, name);
          }

          renderedNativeAudioNodes.set(nativeOfflineAudioContext, nativeOutputNodes === null ? nativeAudioWorkletNode : nativeOutputNodes[2]);

          if (nativeOutputNodes !== null) {
            if (processedBufferPromise === null) {
              if (processorConstructor === undefined) {
                throw new Error('Missing the processor constructor.');
              }

              if (nativeOfflineAudioContextConstructor === null) {
                throw new Error('Missing the native OfflineAudioContext constructor.');
              } // Bug #47: The AudioDestinationNode in Edge and Safari gets not initialized correctly.


              const numberOfInputChannels = proxy.channelCount * proxy.numberOfInputs;
              const numberOfParameters = processorConstructor.parameterDescriptors === undefined ? 0 : processorConstructor.parameterDescriptors.length;
              const numberOfChannels = numberOfInputChannels + numberOfParameters;

              const renderBuffer = async () => {
                const partialOfflineAudioContext = new nativeOfflineAudioContextConstructor(numberOfChannels, // Ceil the length to the next full render quantum.
                // Bug #17: Safari does not yet expose the length.
                Math.ceil(proxy.context.length / 128) * 128, nativeOfflineAudioContext.sampleRate);
                const gainNodes = [];
                const inputChannelSplitterNodes = [];

                for (let i = 0; i < options.numberOfInputs; i += 1) {
                  gainNodes.push(createNativeGainNode(partialOfflineAudioContext, {
                    channelCount: options.channelCount,
                    channelCountMode: options.channelCountMode,
                    channelInterpretation: options.channelInterpretation,
                    gain: 1
                  }));
                  inputChannelSplitterNodes.push(createNativeChannelSplitterNode(partialOfflineAudioContext, {
                    channelCount: options.channelCount,
                    channelCountMode: 'explicit',
                    channelInterpretation: 'discrete',
                    numberOfOutputs: options.channelCount
                  }));
                }

                const constantSourceNodes = await Promise.all(Array.from(proxy.parameters.values()).map(async audioParam => {
                  const constantSourceNode = createNativeConstantSourceNode(partialOfflineAudioContext, {
                    channelCount: 1,
                    channelCountMode: 'explicit',
                    channelInterpretation: 'discrete',
                    offset: audioParam.value
                  });
                  await renderAutomation(partialOfflineAudioContext, audioParam, constantSourceNode.offset, trace);
                  return constantSourceNode;
                }));
                const inputChannelMergerNode = createNativeChannelMergerNode(partialOfflineAudioContext, {
                  channelCount: 1,
                  channelCountMode: 'explicit',
                  channelInterpretation: 'speakers',
                  numberOfInputs: Math.max(1, numberOfInputChannels + numberOfParameters)
                });

                for (let i = 0; i < options.numberOfInputs; i += 1) {
                  gainNodes[i].connect(inputChannelSplitterNodes[i]);

                  for (let j = 0; j < options.channelCount; j += 1) {
                    inputChannelSplitterNodes[i].connect(inputChannelMergerNode, j, i * options.channelCount + j);
                  }
                }

                for (const [index, constantSourceNode] of constantSourceNodes.entries()) {
                  constantSourceNode.connect(inputChannelMergerNode, 0, numberOfInputChannels + index);
                  constantSourceNode.start(0);
                }

                inputChannelMergerNode.connect(partialOfflineAudioContext.destination);
                await Promise.all(gainNodes.map(gainNode => renderInputsOfAudioNode(proxy, partialOfflineAudioContext, gainNode, trace)));
                return renderNativeOfflineAudioContext(partialOfflineAudioContext);
              };

              processedBufferPromise = processBuffer(proxy, numberOfChannels === 0 ? null : await renderBuffer(), nativeOfflineAudioContext, options, processorConstructor, exposeCurrentFrameAndCurrentTime);
            }

            const processedBuffer = await processedBufferPromise;
            const audioBufferSourceNode = createNativeAudioBufferSourceNode(nativeOfflineAudioContext, {
              buffer: null,
              channelCount: 2,
              channelCountMode: 'max',
              channelInterpretation: 'speakers',
              loop: false,
              loopEnd: 0,
              loopStart: 0,
              playbackRate: 1
            });
            const [outputChannelSplitterNode, outputChannelMergerNodes, outputGainNode] = nativeOutputNodes;

            if (processedBuffer !== null) {
              audioBufferSourceNode.buffer = processedBuffer;
              audioBufferSourceNode.start(0);
            }

            audioBufferSourceNode.connect(outputChannelSplitterNode);

            for (let i = 0, outputChannelSplitterNodeOutput = 0; i < proxy.numberOfOutputs; i += 1) {
              const outputChannelMergerNode = outputChannelMergerNodes[i];

              for (let j = 0; j < options.outputChannelCount[i]; j += 1) {
                outputChannelSplitterNode.connect(outputChannelMergerNode, outputChannelSplitterNodeOutput + j, j);
              }

              outputChannelSplitterNodeOutput += options.outputChannelCount[i];
            }

            return outputGainNode;
          }

          if (!nativeAudioWorkletNodeIsOwnedByContext) {
            for (const [nm, audioParam] of proxy.parameters.entries()) {
              await renderAutomation(nativeOfflineAudioContext, audioParam, // @todo The definition that TypeScript uses of the AudioParamMap is lacking many methods.
              nativeAudioWorkletNode.parameters.get(nm), trace);
            }
          } else {
            for (const [nm, audioParam] of proxy.parameters.entries()) {
              await connectAudioParam(nativeOfflineAudioContext, audioParam, // @todo The definition that TypeScript uses of the AudioParamMap is lacking many methods.
              nativeAudioWorkletNode.parameters.get(nm), trace);
            }
          }

          await renderInputsOfAudioNode(proxy, nativeOfflineAudioContext, nativeAudioWorkletNode, trace);
          return nativeAudioWorkletNode;
        };

        return {
          render(proxy, nativeOfflineAudioContext, trace) {
            deleteUnrenderedAudioWorkletNode(nativeOfflineAudioContext, proxy);
            const renderedNativeAudioWorkletNodeOrGainNode = renderedNativeAudioNodes.get(nativeOfflineAudioContext);

            if (renderedNativeAudioWorkletNodeOrGainNode !== undefined) {
              return Promise.resolve(renderedNativeAudioWorkletNodeOrGainNode);
            }

            return createAudioNode(proxy, nativeOfflineAudioContext, trace);
          }

        };
      };
    };

    const createBaseAudioContextConstructor = (addAudioWorkletModule, analyserNodeConstructor, audioBufferConstructor, audioBufferSourceNodeConstructor, biquadFilterNodeConstructor, channelMergerNodeConstructor, channelSplitterNodeConstructor, constantSourceNodeConstructor, convolverNodeConstructor, decodeAudioData, delayNodeConstructor, dynamicsCompressorNodeConstructor, gainNodeConstructor, iIRFilterNodeConstructor, minimalBaseAudioContextConstructor, oscillatorNodeConstructor, pannerNodeConstructor, periodicWaveConstructor, stereoPannerNodeConstructor, waveShaperNodeConstructor) => {
      return class BaseAudioContext extends minimalBaseAudioContextConstructor {
        constructor(_nativeContext, numberOfChannels) {
          super(_nativeContext, numberOfChannels);
          this._nativeContext = _nativeContext;
          this._audioWorklet = addAudioWorkletModule === undefined ? undefined : {
            addModule: (moduleURL, options) => {
              return addAudioWorkletModule(this, moduleURL, options);
            }
          };
        }

        get audioWorklet() {
          return this._audioWorklet;
        }

        createAnalyser() {
          return new analyserNodeConstructor(this);
        }

        createBiquadFilter() {
          return new biquadFilterNodeConstructor(this);
        }

        createBuffer(numberOfChannels, length, sampleRate) {
          return new audioBufferConstructor({
            length,
            numberOfChannels,
            sampleRate
          });
        }

        createBufferSource() {
          return new audioBufferSourceNodeConstructor(this);
        }

        createChannelMerger(numberOfInputs = 6) {
          return new channelMergerNodeConstructor(this, {
            numberOfInputs
          });
        }

        createChannelSplitter(numberOfOutputs = 6) {
          return new channelSplitterNodeConstructor(this, {
            numberOfOutputs
          });
        }

        createConstantSource() {
          return new constantSourceNodeConstructor(this);
        }

        createConvolver() {
          return new convolverNodeConstructor(this);
        }

        createDelay(maxDelayTime = 1) {
          return new delayNodeConstructor(this, {
            maxDelayTime
          });
        }

        createDynamicsCompressor() {
          return new dynamicsCompressorNodeConstructor(this);
        }

        createGain() {
          return new gainNodeConstructor(this);
        }

        createIIRFilter(feedforward, feedback) {
          return new iIRFilterNodeConstructor(this, {
            feedback,
            feedforward
          });
        }

        createOscillator() {
          return new oscillatorNodeConstructor(this);
        }

        createPanner() {
          return new pannerNodeConstructor(this);
        }

        createPeriodicWave(real, imag, constraints = {
          disableNormalization: false
        }) {
          return new periodicWaveConstructor(this, { ...constraints,
            imag,
            real
          });
        }

        createStereoPanner() {
          return new stereoPannerNodeConstructor(this);
        }

        createWaveShaper() {
          return new waveShaperNodeConstructor(this);
        }

        decodeAudioData(audioData, successCallback, errorCallback) {
          return decodeAudioData(this._nativeContext, audioData).then(audioBuffer => {
            if (typeof successCallback === 'function') {
              successCallback(audioBuffer);
            }

            return audioBuffer;
          }).catch(err => {
            if (typeof errorCallback === 'function') {
              errorCallback(err);
            }

            throw err;
          });
        }

      };
    };

    const DEFAULT_OPTIONS$4 = {
      Q: 1,
      channelCount: 2,
      channelCountMode: 'max',
      channelInterpretation: 'speakers',
      detune: 0,
      frequency: 350,
      gain: 0,
      type: 'lowpass'
    };
    const createBiquadFilterNodeConstructor = (audioNodeConstructor, createAudioParam, createBiquadFilterNodeRenderer, createInvalidAccessError, createNativeBiquadFilterNode, getNativeContext, isNativeOfflineAudioContext) => {
      return class BiquadFilterNode extends audioNodeConstructor {
        constructor(context, options = DEFAULT_OPTIONS$4) {
          const nativeContext = getNativeContext(context);
          const mergedOptions = { ...DEFAULT_OPTIONS$4,
            ...options
          };
          const nativeBiquadFilterNode = createNativeBiquadFilterNode(nativeContext, mergedOptions);
          const isOffline = isNativeOfflineAudioContext(nativeContext);
          const biquadFilterNodeRenderer = isOffline ? createBiquadFilterNodeRenderer() : null;
          super(context, false, nativeBiquadFilterNode, biquadFilterNodeRenderer); // Bug #80: Edge & Safari do not export the correct values for maxValue and minValue.

          this._Q = createAudioParam(this, isOffline, nativeBiquadFilterNode.Q, MOST_POSITIVE_SINGLE_FLOAT, MOST_NEGATIVE_SINGLE_FLOAT); // Bug #78: Firefox & Safari do not export the correct values for maxValue and minValue.

          this._detune = createAudioParam(this, isOffline, nativeBiquadFilterNode.detune, 1200 * Math.log2(MOST_POSITIVE_SINGLE_FLOAT), -1200 * Math.log2(MOST_POSITIVE_SINGLE_FLOAT));
          /*
           * Bug #77: Edge does not export the correct values for maxValue and minValue. Firefox & Safari do not export the correct value
           * for minValue.
           */

          this._frequency = createAudioParam(this, isOffline, nativeBiquadFilterNode.frequency, context.sampleRate / 2, 0); // Bug #79: Firefox & Safari do not export the correct values for maxValue and minValue.

          this._gain = createAudioParam(this, isOffline, nativeBiquadFilterNode.gain, 40 * Math.log10(MOST_POSITIVE_SINGLE_FLOAT), MOST_NEGATIVE_SINGLE_FLOAT);
          this._nativeBiquadFilterNode = nativeBiquadFilterNode;
        }

        get detune() {
          return this._detune;
        }

        get frequency() {
          return this._frequency;
        }

        get gain() {
          return this._gain;
        }

        get Q() {
          return this._Q;
        }

        get type() {
          return this._nativeBiquadFilterNode.type;
        }

        set type(value) {
          this._nativeBiquadFilterNode.type = value;
        }

        getFrequencyResponse(frequencyHz, magResponse, phaseResponse) {
          this._nativeBiquadFilterNode.getFrequencyResponse(frequencyHz, magResponse, phaseResponse); // Bug #68: Only Chrome, Firefox & Opera do throw an error if the parameters differ in their length.


          if (frequencyHz.length !== magResponse.length || magResponse.length !== phaseResponse.length) {
            throw createInvalidAccessError();
          }
        }

      };
    };

    const createBiquadFilterNodeRendererFactory = (connectAudioParam, createNativeBiquadFilterNode, getNativeAudioNode, renderAutomation, renderInputsOfAudioNode) => {
      return () => {
        const renderedNativeBiquadFilterNodes = new WeakMap();

        const createBiquadFilterNode = async (proxy, nativeOfflineAudioContext, trace) => {
          let nativeBiquadFilterNode = getNativeAudioNode(proxy);
          /*
           * If the initially used nativeBiquadFilterNode was not constructed on the same OfflineAudioContext it needs to be created
           * again.
           */

          const nativeBiquadFilterNodeIsOwnedByContext = isOwnedByContext(nativeBiquadFilterNode, nativeOfflineAudioContext);

          if (!nativeBiquadFilterNodeIsOwnedByContext) {
            const options = {
              Q: nativeBiquadFilterNode.Q.value,
              channelCount: nativeBiquadFilterNode.channelCount,
              channelCountMode: nativeBiquadFilterNode.channelCountMode,
              channelInterpretation: nativeBiquadFilterNode.channelInterpretation,
              detune: nativeBiquadFilterNode.detune.value,
              frequency: nativeBiquadFilterNode.frequency.value,
              gain: nativeBiquadFilterNode.gain.value,
              type: nativeBiquadFilterNode.type
            };
            nativeBiquadFilterNode = createNativeBiquadFilterNode(nativeOfflineAudioContext, options);
          }

          renderedNativeBiquadFilterNodes.set(nativeOfflineAudioContext, nativeBiquadFilterNode);

          if (!nativeBiquadFilterNodeIsOwnedByContext) {
            await renderAutomation(nativeOfflineAudioContext, proxy.Q, nativeBiquadFilterNode.Q, trace);
            await renderAutomation(nativeOfflineAudioContext, proxy.detune, nativeBiquadFilterNode.detune, trace);
            await renderAutomation(nativeOfflineAudioContext, proxy.frequency, nativeBiquadFilterNode.frequency, trace);
            await renderAutomation(nativeOfflineAudioContext, proxy.gain, nativeBiquadFilterNode.gain, trace);
          } else {
            await connectAudioParam(nativeOfflineAudioContext, proxy.Q, nativeBiquadFilterNode.Q, trace);
            await connectAudioParam(nativeOfflineAudioContext, proxy.detune, nativeBiquadFilterNode.detune, trace);
            await connectAudioParam(nativeOfflineAudioContext, proxy.frequency, nativeBiquadFilterNode.frequency, trace);
            await connectAudioParam(nativeOfflineAudioContext, proxy.gain, nativeBiquadFilterNode.gain, trace);
          }

          await renderInputsOfAudioNode(proxy, nativeOfflineAudioContext, nativeBiquadFilterNode, trace);
          return nativeBiquadFilterNode;
        };

        return {
          render(proxy, nativeOfflineAudioContext, trace) {
            const renderedNativeBiquadFilterNode = renderedNativeBiquadFilterNodes.get(nativeOfflineAudioContext);

            if (renderedNativeBiquadFilterNode !== undefined) {
              return Promise.resolve(renderedNativeBiquadFilterNode);
            }

            return createBiquadFilterNode(proxy, nativeOfflineAudioContext, trace);
          }

        };
      };
    };

    const createCacheTestResult = (ongoingTests, testResults) => {
      return (tester, test) => {
        const cachedTestResult = testResults.get(tester);

        if (cachedTestResult !== undefined) {
          return cachedTestResult;
        }

        const ongoingTest = ongoingTests.get(tester);

        if (ongoingTest !== undefined) {
          return ongoingTest;
        }

        try {
          const synchronousTestResult = test();

          if (synchronousTestResult instanceof Promise) {
            ongoingTests.set(tester, synchronousTestResult);
            return synchronousTestResult.catch(() => false).then(finalTestResult => {
              ongoingTests.delete(tester);
              testResults.set(tester, finalTestResult);
              return finalTestResult;
            });
          }

          testResults.set(tester, synchronousTestResult);
          return synchronousTestResult;
        } catch {
          testResults.set(tester, false);
          return false;
        }
      };
    };

    const DEFAULT_OPTIONS$5 = {
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      numberOfInputs: 6
    };
    const createChannelMergerNodeConstructor = (audioNodeConstructor, createChannelMergerNodeRenderer, createNativeChannelMergerNode, getNativeContext, isNativeOfflineAudioContext) => {
      return class ChannelMergerNode extends audioNodeConstructor {
        constructor(context, options = DEFAULT_OPTIONS$5) {
          const nativeContext = getNativeContext(context);
          const mergedOptions = { ...DEFAULT_OPTIONS$5,
            ...options
          };
          const nativeChannelMergerNode = createNativeChannelMergerNode(nativeContext, mergedOptions);
          const channelMergerNodeRenderer = isNativeOfflineAudioContext(nativeContext) ? createChannelMergerNodeRenderer() : null;
          super(context, false, nativeChannelMergerNode, channelMergerNodeRenderer);
        }

      };
    };

    const createChannelMergerNodeRendererFactory = (createNativeChannelMergerNode, getNativeAudioNode, renderInputsOfAudioNode) => {
      return () => {
        const renderedNativeAudioNodes = new WeakMap();

        const createAudioNode = async (proxy, nativeOfflineAudioContext, trace) => {
          let nativeAudioNode = getNativeAudioNode(proxy); // If the initially used nativeAudioNode was not constructed on the same OfflineAudioContext it needs to be created again.

          const nativeAudioNodeIsOwnedByContext = isOwnedByContext(nativeAudioNode, nativeOfflineAudioContext);

          if (!nativeAudioNodeIsOwnedByContext) {
            const options = {
              channelCount: nativeAudioNode.channelCount,
              channelCountMode: nativeAudioNode.channelCountMode,
              channelInterpretation: nativeAudioNode.channelInterpretation,
              numberOfInputs: nativeAudioNode.numberOfInputs
            };
            nativeAudioNode = createNativeChannelMergerNode(nativeOfflineAudioContext, options);
          }

          renderedNativeAudioNodes.set(nativeOfflineAudioContext, nativeAudioNode);
          await renderInputsOfAudioNode(proxy, nativeOfflineAudioContext, nativeAudioNode, trace);
          return nativeAudioNode;
        };

        return {
          render(proxy, nativeOfflineAudioContext, trace) {
            const renderedNativeAudioNode = renderedNativeAudioNodes.get(nativeOfflineAudioContext);

            if (renderedNativeAudioNode !== undefined) {
              return Promise.resolve(renderedNativeAudioNode);
            }

            return createAudioNode(proxy, nativeOfflineAudioContext, trace);
          }

        };
      };
    };

    const DEFAULT_OPTIONS$6 = {
      channelCount: 6,
      channelCountMode: 'explicit',
      channelInterpretation: 'discrete',
      numberOfOutputs: 6
    };

    const sanitizedOptions$1 = options => {
      return { ...options,
        channelCount: options.numberOfOutputs
      };
    };

    const createChannelSplitterNodeConstructor = (audioNodeConstructor, createChannelSplitterNodeRenderer, createNativeChannelSplitterNode, getNativeContext, isNativeOfflineAudioContext) => {
      return class ChannelSplitterNode extends audioNodeConstructor {
        constructor(context, options = DEFAULT_OPTIONS$6) {
          const nativeContext = getNativeContext(context);
          const mergedOptions = sanitizedOptions$1({ ...DEFAULT_OPTIONS$6,
            ...options
          });
          const nativeChannelSplitterNode = createNativeChannelSplitterNode(nativeContext, mergedOptions);
          const channelSplitterNodeRenderer = isNativeOfflineAudioContext(nativeContext) ? createChannelSplitterNodeRenderer() : null;
          super(context, false, nativeChannelSplitterNode, channelSplitterNodeRenderer);
        }

      };
    };

    const createChannelSplitterNodeRendererFactory = (createNativeChannelSplitterNode, getNativeAudioNode, renderInputsOfAudioNode) => {
      return () => {
        const renderedNativeAudioNodes = new WeakMap();

        const createAudioNode = async (proxy, nativeOfflineAudioContext, trace) => {
          let nativeAudioNode = getNativeAudioNode(proxy); // If the initially used nativeAudioNode was not constructed on the same OfflineAudioContext it needs to be created again.

          const nativeAudioNodeIsOwnedByContext = isOwnedByContext(nativeAudioNode, nativeOfflineAudioContext);

          if (!nativeAudioNodeIsOwnedByContext) {
            const options = {
              channelCount: nativeAudioNode.channelCount,
              channelCountMode: nativeAudioNode.channelCountMode,
              channelInterpretation: nativeAudioNode.channelInterpretation,
              numberOfOutputs: nativeAudioNode.numberOfOutputs
            };
            nativeAudioNode = createNativeChannelSplitterNode(nativeOfflineAudioContext, options);
          }

          renderedNativeAudioNodes.set(nativeOfflineAudioContext, nativeAudioNode);
          await renderInputsOfAudioNode(proxy, nativeOfflineAudioContext, nativeAudioNode, trace);
          return nativeAudioNode;
        };

        return {
          render(proxy, nativeOfflineAudioContext, trace) {
            const renderedNativeAudioNode = renderedNativeAudioNodes.get(nativeOfflineAudioContext);

            if (renderedNativeAudioNode !== undefined) {
              return Promise.resolve(renderedNativeAudioNode);
            }

            return createAudioNode(proxy, nativeOfflineAudioContext, trace);
          }

        };
      };
    };

    const createConnectAudioParam = renderInputsOfAudioParam => {
      return (nativeOfflineAudioContext, audioParam, nativeAudioParam, trace) => {
        return renderInputsOfAudioParam(audioParam, nativeOfflineAudioContext, nativeAudioParam, trace);
      };
    };

    const createConnectMultipleOutputs = createIndexSizeError => {
      return (outputAudioNodes, destination, output = 0, input = 0) => {
        const outputAudioNode = outputAudioNodes[output];

        if (outputAudioNode === undefined) {
          throw createIndexSizeError();
        }

        if (isNativeAudioNode(destination)) {
          return outputAudioNode.connect(destination, 0, input);
        }

        return outputAudioNode.connect(destination, 0);
      };
    };

    const createConnectedNativeAudioBufferSourceNodeFactory = createNativeAudioBufferSourceNode => {
      return (nativeContext, nativeAudioNode) => {
        const nativeAudioBufferSourceNode = createNativeAudioBufferSourceNode(nativeContext, {
          buffer: null,
          channelCount: 2,
          channelCountMode: 'max',
          channelInterpretation: 'speakers',
          loop: false,
          loopEnd: 0,
          loopStart: 0,
          playbackRate: 1
        });
        const nativeAudioBuffer = nativeContext.createBuffer(1, 2, nativeContext.sampleRate);
        nativeAudioBufferSourceNode.buffer = nativeAudioBuffer;
        nativeAudioBufferSourceNode.loop = true;
        nativeAudioBufferSourceNode.connect(nativeAudioNode);
        nativeAudioBufferSourceNode.start();
        return () => {
          nativeAudioBufferSourceNode.stop();
          nativeAudioBufferSourceNode.disconnect(nativeAudioNode);
        };
      };
    };

    const DEFAULT_OPTIONS$7 = {
      channelCount: 2,
      channelCountMode: 'max',
      channelInterpretation: 'speakers',
      offset: 1
    };
    const createConstantSourceNodeConstructor = (audioNodeConstructor, createAudioParam, createConstantSourceNodeRendererFactory, createNativeConstantSourceNode, getNativeContext, isNativeOfflineAudioContext, wrapEventListener) => {
      return class ConstantSourceNode extends audioNodeConstructor {
        constructor(context, options = DEFAULT_OPTIONS$7) {
          const nativeContext = getNativeContext(context);
          const mergedOptions = { ...DEFAULT_OPTIONS$7,
            ...options
          };
          const nativeConstantSourceNode = createNativeConstantSourceNode(nativeContext, mergedOptions);
          const isOffline = isNativeOfflineAudioContext(nativeContext);
          const constantSourceNodeRenderer = isOffline ? createConstantSourceNodeRendererFactory() : null;
          super(context, false, nativeConstantSourceNode, constantSourceNodeRenderer);
          this._constantSourceNodeRenderer = constantSourceNodeRenderer;
          this._nativeConstantSourceNode = nativeConstantSourceNode;
          /*
           * Bug #62 & #74: Edge & Safari do not support ConstantSourceNodes and do not export the correct values for maxValue and
           * minValue for GainNodes.
           */

          this._offset = createAudioParam(this, isOffline, nativeConstantSourceNode.offset, MOST_POSITIVE_SINGLE_FLOAT, MOST_NEGATIVE_SINGLE_FLOAT);
          this._onended = null;
        }

        get offset() {
          return this._offset;
        }

        get onended() {
          return this._onended;
        }

        set onended(value) {
          const wrappedListener = typeof value === 'function' ? wrapEventListener(this, value) : null;
          this._nativeConstantSourceNode.onended = wrappedListener;
          const nativeOnEnded = this._nativeConstantSourceNode.onended;
          this._onended = nativeOnEnded !== null && nativeOnEnded === wrappedListener ? value : nativeOnEnded;
        }

        start(when = 0) {
          this._nativeConstantSourceNode.start(when);

          if (this._constantSourceNodeRenderer !== null) {
            this._constantSourceNodeRenderer.start = when;
          } else {
            setInternalStateToActive(this);

            const resetInternalStateToPassive = () => {
              this._nativeConstantSourceNode.removeEventListener('ended', resetInternalStateToPassive); // @todo Determine a meaningful delay instead of just using one second.


              setTimeout(() => setInternalStateToPassive(this), 1000);
            };

            this._nativeConstantSourceNode.addEventListener('ended', resetInternalStateToPassive);
          }
        }

        stop(when = 0) {
          this._nativeConstantSourceNode.stop(when);

          if (this._constantSourceNodeRenderer !== null) {
            this._constantSourceNodeRenderer.stop = when;
          }
        }

      };
    };

    const createConstantSourceNodeRendererFactory = (connectAudioParam, createNativeConstantSourceNode, getNativeAudioNode, renderAutomation, renderInputsOfAudioNode) => {
      return () => {
        const renderedNativeConstantSourceNodes = new WeakMap();
        let start = null;
        let stop = null;

        const createConstantSourceNode = async (proxy, nativeOfflineAudioContext, trace) => {
          let nativeConstantSourceNode = getNativeAudioNode(proxy);
          /*
           * If the initially used nativeConstantSourceNode was not constructed on the same OfflineAudioContext it needs to be created
           * again.
           */

          const nativeConstantSourceNodeIsOwnedByContext = isOwnedByContext(nativeConstantSourceNode, nativeOfflineAudioContext);

          if (!nativeConstantSourceNodeIsOwnedByContext) {
            const options = {
              channelCount: nativeConstantSourceNode.channelCount,
              channelCountMode: nativeConstantSourceNode.channelCountMode,
              channelInterpretation: nativeConstantSourceNode.channelInterpretation,
              offset: nativeConstantSourceNode.offset.value
            };
            nativeConstantSourceNode = createNativeConstantSourceNode(nativeOfflineAudioContext, options);

            if (start !== null) {
              nativeConstantSourceNode.start(start);
            }

            if (stop !== null) {
              nativeConstantSourceNode.stop(stop);
            }
          }

          renderedNativeConstantSourceNodes.set(nativeOfflineAudioContext, nativeConstantSourceNode);

          if (!nativeConstantSourceNodeIsOwnedByContext) {
            await renderAutomation(nativeOfflineAudioContext, proxy.offset, nativeConstantSourceNode.offset, trace);
          } else {
            await connectAudioParam(nativeOfflineAudioContext, proxy.offset, nativeConstantSourceNode.offset, trace);
          }

          await renderInputsOfAudioNode(proxy, nativeOfflineAudioContext, nativeConstantSourceNode, trace);
          return nativeConstantSourceNode;
        };

        return {
          set start(value) {
            start = value;
          },

          set stop(value) {
            stop = value;
          },

          render(proxy, nativeOfflineAudioContext, trace) {
            const renderedNativeConstantSourceNode = renderedNativeConstantSourceNodes.get(nativeOfflineAudioContext);

            if (renderedNativeConstantSourceNode !== undefined) {
              return Promise.resolve(renderedNativeConstantSourceNode);
            }

            return createConstantSourceNode(proxy, nativeOfflineAudioContext, trace);
          }

        };
      };
    };

    const createConvertNumberToUnsignedLong = unit32Array => {
      return value => {
        unit32Array[0] = value;
        return unit32Array[0];
      };
    };

    const DEFAULT_OPTIONS$8 = {
      buffer: null,
      channelCount: 2,
      channelCountMode: 'clamped-max',
      channelInterpretation: 'speakers',
      disableNormalization: false
    };
    const createConvolverNodeConstructor = (audioNodeConstructor, createConvolverNodeRenderer, createNativeConvolverNode, getNativeContext, isNativeOfflineAudioContext) => {
      return class ConvolverNode extends audioNodeConstructor {
        constructor(context, options = DEFAULT_OPTIONS$8) {
          const nativeContext = getNativeContext(context);
          const mergedOptions = { ...DEFAULT_OPTIONS$8,
            ...options
          };
          const nativeConvolverNode = createNativeConvolverNode(nativeContext, mergedOptions);
          const isOffline = isNativeOfflineAudioContext(nativeContext);
          const convolverNodeRenderer = isOffline ? createConvolverNodeRenderer() : null;
          super(context, false, nativeConvolverNode, convolverNodeRenderer);
          this._isBufferNullified = false;
          this._nativeConvolverNode = nativeConvolverNode;
        }

        get buffer() {
          if (this._isBufferNullified) {
            return null;
          }

          return this._nativeConvolverNode.buffer;
        }

        set buffer(value) {
          this._nativeConvolverNode.buffer = value; // Bug #115: Safari does not allow to set the buffer to null.

          if (value === null && this._nativeConvolverNode.buffer !== null) {
            const nativeContext = this._nativeConvolverNode.context;
            this._nativeConvolverNode.buffer = nativeContext.createBuffer(1, 1, nativeContext.sampleRate);
            this._isBufferNullified = true;
          } else {
            this._isBufferNullified = false;
          }
        }

        get normalize() {
          return this._nativeConvolverNode.normalize;
        }

        set normalize(value) {
          this._nativeConvolverNode.normalize = value;
        }

      };
    };

    const createConvolverNodeRendererFactory = (createNativeConvolverNode, getNativeAudioNode, renderInputsOfAudioNode) => {
      return () => {
        const renderedNativeConvolverNodes = new WeakMap();

        const createConvolverNode = async (proxy, nativeOfflineAudioContext, trace) => {
          let nativeConvolverNode = getNativeAudioNode(proxy); // If the initially used nativeConvolverNode was not constructed on the same OfflineAudioContext it needs to be created again.

          const nativeConvolverNodeIsOwnedByContext = isOwnedByContext(nativeConvolverNode, nativeOfflineAudioContext);

          if (!nativeConvolverNodeIsOwnedByContext) {
            const options = {
              buffer: nativeConvolverNode.buffer,
              channelCount: nativeConvolverNode.channelCount,
              channelCountMode: nativeConvolverNode.channelCountMode,
              channelInterpretation: nativeConvolverNode.channelInterpretation,
              disableNormalization: !nativeConvolverNode.normalize
            };
            nativeConvolverNode = createNativeConvolverNode(nativeOfflineAudioContext, options);
          }

          renderedNativeConvolverNodes.set(nativeOfflineAudioContext, nativeConvolverNode);

          if (isNativeAudioNodeFaker(nativeConvolverNode)) {
            await renderInputsOfAudioNode(proxy, nativeOfflineAudioContext, nativeConvolverNode.inputs[0], trace);
          } else {
            await renderInputsOfAudioNode(proxy, nativeOfflineAudioContext, nativeConvolverNode, trace);
          }

          return nativeConvolverNode;
        };

        return {
          render(proxy, nativeOfflineAudioContext, trace) {
            const renderedNativeConvolverNode = renderedNativeConvolverNodes.get(nativeOfflineAudioContext);

            if (renderedNativeConvolverNode !== undefined) {
              return Promise.resolve(renderedNativeConvolverNode);
            }

            return createConvolverNode(proxy, nativeOfflineAudioContext, trace);
          }

        };
      };
    };

    const createCreateNativeOfflineAudioContext = (createNotSupportedError, nativeOfflineAudioContextConstructor) => {
      return (numberOfChannels, length, sampleRate) => {
        if (nativeOfflineAudioContextConstructor === null) {
          throw new Error('Missing the native OfflineAudioContext constructor.');
        }

        try {
          return new nativeOfflineAudioContextConstructor(numberOfChannels, length, sampleRate);
        } catch (err) {
          // Bug #143, #144 & #146: Safari throws a SyntaxError when numberOfChannels, length or sampleRate are invalid.
          // Bug #143: Edge throws a SyntaxError when numberOfChannels or length are invalid.
          // Bug #145: Edge throws an IndexSizeError when sampleRate is zero.
          if (err.name === 'IndexSizeError' || err.name === 'SyntaxError') {
            throw createNotSupportedError();
          }

          throw err;
        }
      };
    };

    const createDataCloneError = () => {
      try {
        return new DOMException('', 'DataCloneError');
      } catch (err) {
        // Bug #122: Edge is the only browser that does not yet allow to construct a DOMException.
        err.code = 25;
        err.name = 'DataCloneError';
        return err;
      }
    };

    const detachArrayBuffer = arrayBuffer => {
      const {
        port1
      } = new MessageChannel();
      port1.postMessage(arrayBuffer, [arrayBuffer]);
    };

    const createDecodeAudioData = (audioBufferStore, cacheTestResult, createDataCloneError, createEncodingError, detachedArrayBuffers, getNativeContext, isNativeContext, isNativeOfflineAudioContext, nativeOfflineAudioContextConstructor, testAudioBufferCopyChannelMethodsOutOfBoundsSupport, testPromiseSupport, wrapAudioBufferCopyChannelMethods, wrapAudioBufferCopyChannelMethodsOutOfBounds) => {
      return (anyContext, audioData) => {
        const nativeContext = isNativeContext(anyContext) ? anyContext : getNativeContext(anyContext); // Bug #43: Only Chrome and Opera do throw a DataCloneError.

        if (detachedArrayBuffers.has(audioData)) {
          const err = createDataCloneError();
          return Promise.reject(err);
        } // The audioData parameter maybe of a type which can't be added to a WeakSet.


        try {
          detachedArrayBuffers.add(audioData);
        } catch {// Ignore errors.
        } // Bug #21: Safari does not support promises yet.


        if (cacheTestResult(testPromiseSupport, () => testPromiseSupport(nativeContext))) {
          // Bug #101: Edge does not decode something on a closed OfflineAudioContext.
          const nativeContextOrBackupNativeContext = nativeContext.state === 'closed' && nativeOfflineAudioContextConstructor !== null && isNativeOfflineAudioContext(nativeContext) ? new nativeOfflineAudioContextConstructor(1, 1, nativeContext.sampleRate) : nativeContext;
          const promise = nativeContextOrBackupNativeContext.decodeAudioData(audioData).catch(err => {
            // Bug #27: Edge is rejecting invalid arrayBuffers with a DOMException.
            if (err instanceof DOMException && err.name === 'NotSupportedError') {
              throw new TypeError();
            }

            throw err;
          });
          return promise.then(audioBuffer => {
            // Bug #157: Only Chrome & Opera do allow the bufferOffset to be out-of-bounds.
            if (!cacheTestResult(testAudioBufferCopyChannelMethodsOutOfBoundsSupport, () => testAudioBufferCopyChannelMethodsOutOfBoundsSupport(audioBuffer))) {
              wrapAudioBufferCopyChannelMethodsOutOfBounds(audioBuffer);
            }

            audioBufferStore.add(audioBuffer);
            return audioBuffer;
          });
        } // Bug #21: Safari does not return a Promise yet.


        return new Promise((resolve, reject) => {
          const complete = () => {
            // Bug #133: Safari does neuter the ArrayBuffer.
            try {
              detachArrayBuffer(audioData);
            } catch {// Ignore errors.
            }
          };

          const fail = err => {
            reject(err);
            complete();
          }; // Bug #26: Safari throws a synchronous error.


          try {
            // Bug #1: Safari requires a successCallback.
            nativeContext.decodeAudioData(audioData, audioBuffer => {
              // Bug #5: Safari does not support copyFromChannel() and copyToChannel().
              // Bug #100: Safari does throw a wrong error when calling getChannelData() with an out-of-bounds value.
              if (typeof audioBuffer.copyFromChannel !== 'function') {
                wrapAudioBufferCopyChannelMethods(audioBuffer);
                wrapAudioBufferGetChannelDataMethod(audioBuffer);
              }

              audioBufferStore.add(audioBuffer);
              complete();
              resolve(audioBuffer);
            }, err => {
              // Bug #4: Safari returns null instead of an error.
              if (err === null) {
                fail(createEncodingError());
              } else {
                fail(err);
              }
            });
          } catch (err) {
            fail(err);
          }
        });
      };
    };

    const createDecrementCycleCounter = (connectNativeAudioNodeToNativeAudioNode, cycleCounters, getAudioNodeConnections, getNativeAudioNode, getNativeAudioParam, getNativeContext, isActiveAudioNode, isNativeOfflineAudioContext) => {
      return (audioNode, count) => {
        const cycleCounter = cycleCounters.get(audioNode);

        if (cycleCounter === undefined) {
          throw new Error('Missing the expected cycle count.');
        }

        const nativeContext = getNativeContext(audioNode.context);
        const isOffline = isNativeOfflineAudioContext(nativeContext);

        if (cycleCounter === count) {
          cycleCounters.delete(audioNode);

          if (!isOffline && isActiveAudioNode(audioNode)) {
            const nativeSourceAudioNode = getNativeAudioNode(audioNode);
            const {
              outputs
            } = getAudioNodeConnections(audioNode);

            for (const output of outputs) {
              if (isAudioNodeOutputConnection(output)) {
                const nativeDestinationAudioNode = getNativeAudioNode(output[0]);
                connectNativeAudioNodeToNativeAudioNode(nativeSourceAudioNode, nativeDestinationAudioNode, output[1], output[2]);
              } else {
                const nativeDestinationAudioParam = getNativeAudioParam(output[0]);
                nativeSourceAudioNode.connect(nativeDestinationAudioParam, output[1]);
              }
            }
          }
        } else {
          cycleCounters.set(audioNode, cycleCounter - count);
        }
      };
    };

    const DEFAULT_OPTIONS$9 = {
      channelCount: 2,
      channelCountMode: 'max',
      channelInterpretation: 'speakers',
      delayTime: 0,
      maxDelayTime: 1
    };
    const createDelayNodeConstructor = (audioNodeConstructor, createAudioParam, createDelayNodeRenderer, createNativeDelayNode, getNativeContext, isNativeOfflineAudioContext) => {
      return class DelayNode extends audioNodeConstructor {
        constructor(context, options = DEFAULT_OPTIONS$9) {
          const nativeContext = getNativeContext(context);
          const mergedOptions = { ...DEFAULT_OPTIONS$9,
            ...options
          };
          const nativeDelayNode = createNativeDelayNode(nativeContext, mergedOptions);
          const isOffline = isNativeOfflineAudioContext(nativeContext);
          const delayNodeRenderer = isOffline ? createDelayNodeRenderer(mergedOptions.maxDelayTime) : null;
          super(context, false, nativeDelayNode, delayNodeRenderer); // Bug #161: Edge does not export the correct values for maxValue and minValue.

          this._delayTime = createAudioParam(this, isOffline, nativeDelayNode.delayTime, mergedOptions.maxDelayTime, 0);
        }

        get delayTime() {
          return this._delayTime;
        }

      };
    };

    const createDelayNodeRendererFactory = (connectAudioParam, createNativeDelayNode, getNativeAudioNode, renderAutomation, renderInputsOfAudioNode) => {
      return maxDelayTime => {
        const renderedNativeDelayNodes = new WeakMap();

        const createDelayNode = async (proxy, nativeOfflineAudioContext, trace) => {
          let nativeDelayNode = getNativeAudioNode(proxy); // If the initially used nativeDelayNode was not constructed on the same OfflineAudioContext it needs to be created again.

          const nativeDelayNodeIsOwnedByContext = isOwnedByContext(nativeDelayNode, nativeOfflineAudioContext);

          if (!nativeDelayNodeIsOwnedByContext) {
            const options = {
              channelCount: nativeDelayNode.channelCount,
              channelCountMode: nativeDelayNode.channelCountMode,
              channelInterpretation: nativeDelayNode.channelInterpretation,
              delayTime: nativeDelayNode.delayTime.value,
              maxDelayTime
            };
            nativeDelayNode = createNativeDelayNode(nativeOfflineAudioContext, options);
          }

          renderedNativeDelayNodes.set(nativeOfflineAudioContext, nativeDelayNode);

          if (!nativeDelayNodeIsOwnedByContext) {
            await renderAutomation(nativeOfflineAudioContext, proxy.delayTime, nativeDelayNode.delayTime, trace);
          } else {
            await connectAudioParam(nativeOfflineAudioContext, proxy.delayTime, nativeDelayNode.delayTime, trace);
          }

          await renderInputsOfAudioNode(proxy, nativeOfflineAudioContext, nativeDelayNode, trace);
          return nativeDelayNode;
        };

        return {
          render(proxy, nativeOfflineAudioContext, trace) {
            const renderedNativeDelayNode = renderedNativeDelayNodes.get(nativeOfflineAudioContext);

            if (renderedNativeDelayNode !== undefined) {
              return Promise.resolve(renderedNativeDelayNode);
            }

            return createDelayNode(proxy, nativeOfflineAudioContext, trace);
          }

        };
      };
    };

    const createDeleteUnrenderedAudioWorkletNode = getUnrenderedAudioWorkletNodes => {
      return (nativeContext, audioWorkletNode) => {
        getUnrenderedAudioWorkletNodes(nativeContext).delete(audioWorkletNode);
      };
    };

    const isDelayNode = audioNode => {
      return 'delayTime' in audioNode;
    };

    const createDetectCycles = (audioParamAudioNodeStore, getAudioNodeConnections, getValueForKey) => {
      return function detectCycles(chain, nextLink) {
        const audioNode = isAudioNode(nextLink) ? nextLink : getValueForKey(audioParamAudioNodeStore, nextLink);

        if (isDelayNode(audioNode)) {
          return [];
        }

        if (chain[0] === audioNode) {
          return [chain];
        }

        if (chain.includes(audioNode)) {
          return [];
        }

        const {
          outputs
        } = getAudioNodeConnections(audioNode);
        return Array.from(outputs).map(outputConnection => detectCycles([...chain, audioNode], outputConnection[0])).reduce((mergedCycles, nestedCycles) => mergedCycles.concat(nestedCycles), []);
      };
    };

    const getOutputAudioNodeAtIndex = (createIndexSizeError, outputAudioNodes, output) => {
      const outputAudioNode = outputAudioNodes[output];

      if (outputAudioNode === undefined) {
        throw createIndexSizeError();
      }

      return outputAudioNode;
    };

    const createDisconnectMultipleOutputs = createIndexSizeError => {
      return (outputAudioNodes, destinationOrOutput = undefined, output = undefined, input = 0) => {
        if (destinationOrOutput === undefined) {
          return outputAudioNodes.forEach(outputAudioNode => outputAudioNode.disconnect());
        }

        if (typeof destinationOrOutput === 'number') {
          return getOutputAudioNodeAtIndex(createIndexSizeError, outputAudioNodes, destinationOrOutput).disconnect();
        }

        if (isNativeAudioNode(destinationOrOutput)) {
          if (output === undefined) {
            return outputAudioNodes.forEach(outputAudioNode => outputAudioNode.disconnect(destinationOrOutput));
          }

          if (input === undefined) {
            return getOutputAudioNodeAtIndex(createIndexSizeError, outputAudioNodes, output).disconnect(destinationOrOutput, 0);
          }

          return getOutputAudioNodeAtIndex(createIndexSizeError, outputAudioNodes, output).disconnect(destinationOrOutput, 0, input);
        }

        if (output === undefined) {
          return outputAudioNodes.forEach(outputAudioNode => outputAudioNode.disconnect(destinationOrOutput));
        }

        return getOutputAudioNodeAtIndex(createIndexSizeError, outputAudioNodes, output).disconnect(destinationOrOutput, 0);
      };
    };

    const DEFAULT_OPTIONS$a = {
      attack: 0.003,
      channelCount: 2,
      channelCountMode: 'clamped-max',
      channelInterpretation: 'speakers',
      knee: 30,
      ratio: 12,
      release: 0.25,
      threshold: -24
    };
    const createDynamicsCompressorNodeConstructor = (audioNodeConstructor, createAudioParam, createDynamicsCompressorNodeRenderer, createNativeDynamicsCompressorNode, createNotSupportedError, getNativeContext, isNativeOfflineAudioContext) => {
      return class DynamicsCompressorNode extends audioNodeConstructor {
        constructor(context, options = DEFAULT_OPTIONS$a) {
          const nativeContext = getNativeContext(context);
          const mergedOptions = { ...DEFAULT_OPTIONS$a,
            ...options
          };
          const nativeDynamicsCompressorNode = createNativeDynamicsCompressorNode(nativeContext, mergedOptions);
          const isOffline = isNativeOfflineAudioContext(nativeContext);
          const dynamicsCompressorNodeRenderer = isOffline ? createDynamicsCompressorNodeRenderer() : null;
          super(context, false, nativeDynamicsCompressorNode, dynamicsCompressorNodeRenderer); // Bug #110: Edge does not export the correct values for maxValue and minValue.

          this._attack = createAudioParam(this, isOffline, nativeDynamicsCompressorNode.attack, 1, 0);
          this._knee = createAudioParam(this, isOffline, nativeDynamicsCompressorNode.knee, 40, 0);
          this._nativeDynamicsCompressorNode = nativeDynamicsCompressorNode;
          this._ratio = createAudioParam(this, isOffline, nativeDynamicsCompressorNode.ratio, 20, 1);
          this._release = createAudioParam(this, isOffline, nativeDynamicsCompressorNode.release, 1, 0);
          this._threshold = createAudioParam(this, isOffline, nativeDynamicsCompressorNode.threshold, 0, -100);
        }

        get attack() {
          return this._attack;
        }
        /*
         * Bug #108: Only Chrome, Firefox and Opera disallow a channelCount of three and above yet which is why the getter and setter needs
         * to be overwritten here.
         */


        get channelCount() {
          return this._nativeDynamicsCompressorNode.channelCount;
        }

        set channelCount(value) {
          const previousChannelCount = this._nativeDynamicsCompressorNode.channelCount;
          this._nativeDynamicsCompressorNode.channelCount = value;

          if (value > 2) {
            this._nativeDynamicsCompressorNode.channelCount = previousChannelCount;
            throw createNotSupportedError();
          }
        }
        /*
         * Bug #109: Only Chrome, Firefox and Opera disallow a channelCountMode of 'max' yet which is why the getter and setter needs to be
         * overwritten here.
         */


        get channelCountMode() {
          return this._nativeDynamicsCompressorNode.channelCountMode;
        }

        set channelCountMode(value) {
          const previousChannelCount = this._nativeDynamicsCompressorNode.channelCountMode;
          this._nativeDynamicsCompressorNode.channelCountMode = value;

          if (value === 'max') {
            this._nativeDynamicsCompressorNode.channelCountMode = previousChannelCount;
            throw createNotSupportedError();
          }
        }

        get knee() {
          return this._knee;
        }

        get ratio() {
          return this._ratio;
        }

        get reduction() {
          // Bug #111: Safari returns an AudioParam instead of a number.
          if (typeof this._nativeDynamicsCompressorNode.reduction.value === 'number') {
            return this._nativeDynamicsCompressorNode.reduction.value;
          }

          return this._nativeDynamicsCompressorNode.reduction;
        }

        get release() {
          return this._release;
        }

        get threshold() {
          return this._threshold;
        }

      };
    };

    const createDynamicsCompressorNodeRendererFactory = (connectAudioParam, createNativeDynamicsCompressorNode, getNativeAudioNode, renderAutomation, renderInputsOfAudioNode) => {
      return () => {
        const renderedNativeDynamicsCompressorNodes = new WeakMap();

        const createDynamicsCompressorNode = async (proxy, nativeOfflineAudioContext, trace) => {
          let nativeDynamicsCompressorNode = getNativeAudioNode(proxy);
          /*
           * If the initially used nativeDynamicsCompressorNode was not constructed on the same OfflineAudioContext it needs to be
           * created again.
           */

          const nativeDynamicsCompressorNodeIsOwnedByContext = isOwnedByContext(nativeDynamicsCompressorNode, nativeOfflineAudioContext);

          if (!nativeDynamicsCompressorNodeIsOwnedByContext) {
            const options = {
              attack: nativeDynamicsCompressorNode.attack.value,
              channelCount: nativeDynamicsCompressorNode.channelCount,
              channelCountMode: nativeDynamicsCompressorNode.channelCountMode,
              channelInterpretation: nativeDynamicsCompressorNode.channelInterpretation,
              knee: nativeDynamicsCompressorNode.knee.value,
              ratio: nativeDynamicsCompressorNode.ratio.value,
              release: nativeDynamicsCompressorNode.release.value,
              threshold: nativeDynamicsCompressorNode.threshold.value
            };
            nativeDynamicsCompressorNode = createNativeDynamicsCompressorNode(nativeOfflineAudioContext, options);
          }

          renderedNativeDynamicsCompressorNodes.set(nativeOfflineAudioContext, nativeDynamicsCompressorNode);

          if (!nativeDynamicsCompressorNodeIsOwnedByContext) {
            await renderAutomation(nativeOfflineAudioContext, proxy.attack, nativeDynamicsCompressorNode.attack, trace);
            await renderAutomation(nativeOfflineAudioContext, proxy.knee, nativeDynamicsCompressorNode.knee, trace);
            await renderAutomation(nativeOfflineAudioContext, proxy.ratio, nativeDynamicsCompressorNode.ratio, trace);
            await renderAutomation(nativeOfflineAudioContext, proxy.release, nativeDynamicsCompressorNode.release, trace);
            await renderAutomation(nativeOfflineAudioContext, proxy.threshold, nativeDynamicsCompressorNode.threshold, trace);
          } else {
            await connectAudioParam(nativeOfflineAudioContext, proxy.attack, nativeDynamicsCompressorNode.attack, trace);
            await connectAudioParam(nativeOfflineAudioContext, proxy.knee, nativeDynamicsCompressorNode.knee, trace);
            await connectAudioParam(nativeOfflineAudioContext, proxy.ratio, nativeDynamicsCompressorNode.ratio, trace);
            await connectAudioParam(nativeOfflineAudioContext, proxy.release, nativeDynamicsCompressorNode.release, trace);
            await connectAudioParam(nativeOfflineAudioContext, proxy.threshold, nativeDynamicsCompressorNode.threshold, trace);
          }

          await renderInputsOfAudioNode(proxy, nativeOfflineAudioContext, nativeDynamicsCompressorNode, trace);
          return nativeDynamicsCompressorNode;
        };

        return {
          render(proxy, nativeOfflineAudioContext, trace) {
            const renderedNativeDynamicsCompressorNode = renderedNativeDynamicsCompressorNodes.get(nativeOfflineAudioContext);

            if (renderedNativeDynamicsCompressorNode !== undefined) {
              return Promise.resolve(renderedNativeDynamicsCompressorNode);
            }

            return createDynamicsCompressorNode(proxy, nativeOfflineAudioContext, trace);
          }

        };
      };
    };

    const createEncodingError = () => {
      try {
        return new DOMException('', 'EncodingError');
      } catch (err) {
        // Bug #122: Edge is the only browser that does not yet allow to construct a DOMException.
        err.code = 0;
        err.name = 'EncodingError';
        return err;
      }
    };

    const createEvaluateSource = window => {
      return source => new Promise((resolve, reject) => {
        if (window === null) {
          reject(new SyntaxError());
          return;
        }

        const head = window.document.head;

        if (head === null) {
          reject(new SyntaxError());
        } else {
          const script = window.document.createElement('script'); // @todo Safari doesn't like URLs with a type of 'application/javascript; charset=utf-8'.

          const blob = new Blob([source], {
            type: 'application/javascript'
          });
          const url = URL.createObjectURL(blob);
          const originalOnErrorHandler = window.onerror;

          const removeErrorEventListenerAndRevokeUrl = () => {
            window.onerror = originalOnErrorHandler;
            URL.revokeObjectURL(url);
          };

          window.onerror = (message, src, lineno, colno, error) => {
            // @todo Edge thinks the source is the one of the html document.
            if (src === url || src === window.location.href && lineno === 1 && colno === 1) {
              removeErrorEventListenerAndRevokeUrl();
              reject(error);
              return false;
            }

            if (originalOnErrorHandler !== null) {
              return originalOnErrorHandler(message, src, lineno, colno, error);
            }
          };

          script.onerror = () => {
            removeErrorEventListenerAndRevokeUrl();
            reject(new SyntaxError());
          };

          script.onload = () => {
            removeErrorEventListenerAndRevokeUrl();
            resolve();
          };

          script.src = url;
          script.type = 'module';
          head.appendChild(script);
        }
      });
    };

    const createEventTargetConstructor = wrapEventListener => {
      return class EventTarget {
        constructor(_nativeEventTarget) {
          this._nativeEventTarget = _nativeEventTarget;
          this._listeners = new WeakMap();
        }

        addEventListener(type, listener, options) {
          if (listener !== null) {
            let wrappedEventListener = this._listeners.get(listener);

            if (wrappedEventListener === undefined) {
              wrappedEventListener = wrapEventListener(this, listener);

              if (typeof listener === 'function') {
                this._listeners.set(listener, wrappedEventListener);
              }
            }

            this._nativeEventTarget.addEventListener(type, wrappedEventListener, options);
          }
        }

        dispatchEvent(event) {
          return this._nativeEventTarget.dispatchEvent(event);
        }

        removeEventListener(type, listener, options) {
          const wrappedEventListener = listener === null ? undefined : this._listeners.get(listener);

          this._nativeEventTarget.removeEventListener(type, wrappedEventListener === undefined ? null : wrappedEventListener, options);
        }

      };
    };

    const createExposeCurrentFrameAndCurrentTime = window => {
      return (currentTime, sampleRate, fn) => {
        Object.defineProperties(window, {
          currentFrame: {
            configurable: true,

            get() {
              return Math.round(currentTime * sampleRate);
            }

          },
          currentTime: {
            configurable: true,

            get() {
              return currentTime;
            }

          }
        });

        try {
          return fn();
        } finally {
          if (window !== null) {
            delete window.currentFrame;
            delete window.currentTime;
          }
        }
      };
    };

    const createFetchSource = createAbortError => {
      return async url => {
        try {
          const response = await fetch(url);

          if (response.ok) {
            return response.text();
          }
        } catch {// Ignore errors.
        } // tslint:disable-line:no-empty


        throw createAbortError();
      };
    };

    const DEFAULT_OPTIONS$b = {
      channelCount: 2,
      channelCountMode: 'max',
      channelInterpretation: 'speakers',
      gain: 1
    };
    const createGainNodeConstructor = (audioNodeConstructor, createAudioParam, createGainNodeRenderer, createNativeGainNode, getNativeContext, isNativeOfflineAudioContext) => {
      return class GainNode extends audioNodeConstructor {
        constructor(context, options = DEFAULT_OPTIONS$b) {
          const nativeContext = getNativeContext(context);
          const mergedOptions = { ...DEFAULT_OPTIONS$b,
            ...options
          };
          const nativeGainNode = createNativeGainNode(nativeContext, mergedOptions);
          const isOffline = isNativeOfflineAudioContext(nativeContext);
          const gainNodeRenderer = isOffline ? createGainNodeRenderer() : null;
          super(context, false, nativeGainNode, gainNodeRenderer); // Bug #74: Edge & Safari do not export the correct values for maxValue and minValue.

          this._gain = createAudioParam(this, isOffline, nativeGainNode.gain, MOST_POSITIVE_SINGLE_FLOAT, MOST_NEGATIVE_SINGLE_FLOAT);
        }

        get gain() {
          return this._gain;
        }

      };
    };

    const createGainNodeRendererFactory = (connectAudioParam, createNativeGainNode, getNativeAudioNode, renderAutomation, renderInputsOfAudioNode) => {
      return () => {
        const renderedNativeGainNodes = new WeakMap();

        const createGainNode = async (proxy, nativeOfflineAudioContext, trace) => {
          let nativeGainNode = getNativeAudioNode(proxy); // If the initially used nativeGainNode was not constructed on the same OfflineAudioContext it needs to be created again.

          const nativeGainNodeIsOwnedByContext = isOwnedByContext(nativeGainNode, nativeOfflineAudioContext);

          if (!nativeGainNodeIsOwnedByContext) {
            const options = {
              channelCount: nativeGainNode.channelCount,
              channelCountMode: nativeGainNode.channelCountMode,
              channelInterpretation: nativeGainNode.channelInterpretation,
              gain: nativeGainNode.gain.value
            };
            nativeGainNode = createNativeGainNode(nativeOfflineAudioContext, options);
          }

          renderedNativeGainNodes.set(nativeOfflineAudioContext, nativeGainNode);

          if (!nativeGainNodeIsOwnedByContext) {
            await renderAutomation(nativeOfflineAudioContext, proxy.gain, nativeGainNode.gain, trace);
          } else {
            await connectAudioParam(nativeOfflineAudioContext, proxy.gain, nativeGainNode.gain, trace);
          }

          await renderInputsOfAudioNode(proxy, nativeOfflineAudioContext, nativeGainNode, trace);
          return nativeGainNode;
        };

        return {
          render(proxy, nativeOfflineAudioContext, trace) {
            const renderedNativeGainNode = renderedNativeGainNodes.get(nativeOfflineAudioContext);

            if (renderedNativeGainNode !== undefined) {
              return Promise.resolve(renderedNativeGainNode);
            }

            return createGainNode(proxy, nativeOfflineAudioContext, trace);
          }

        };
      };
    };

    const createGetAudioNodeRenderer = getAudioNodeConnections => {
      return audioNode => {
        const audioNodeConnections = getAudioNodeConnections(audioNode);

        if (audioNodeConnections.renderer === null) {
          throw new Error('Missing the renderer of the given AudioNode in the audio graph.');
        }

        return audioNodeConnections.renderer;
      };
    };

    const createGetAudioParamRenderer = getAudioParamConnections => {
      return audioParam => {
        const audioParamConnections = getAudioParamConnections(audioParam);

        if (audioParamConnections.renderer === null) {
          throw new Error('Missing the renderer of the given AudioParam in the audio graph.');
        }

        return audioParamConnections.renderer;
      };
    };

    const createGetBackupNativeContext = (isNativeOfflineAudioContext, nativeAudioContextConstructor, nativeOfflineAudioContextConstructor) => {
      return nativeContext => {
        /*
         * Bug #50: Only Edge does currently not allow to create AudioNodes on a closed context yet which is why there needs to be no
         * backupNativeContext in that case.
         */
        if (nativeContext.state === 'closed' && nativeAudioContextConstructor !== null && nativeAudioContextConstructor.name !== 'webkitAudioContext') {
          if (isNativeOfflineAudioContext(nativeContext)) {
            const backupNativeContext = BACKUP_NATIVE_CONTEXT_STORE.get(nativeContext);

            if (backupNativeContext !== undefined) {
              return backupNativeContext;
            }

            if (nativeOfflineAudioContextConstructor !== null) {
              // @todo Copy the attached AudioWorkletProcessors and other settings.
              const bckpNtveCntxt = new nativeOfflineAudioContextConstructor(1, 1, 44100);
              BACKUP_NATIVE_CONTEXT_STORE.set(nativeContext, bckpNtveCntxt);
              return bckpNtveCntxt;
            }
          } else {
            const backupNativeContext = BACKUP_NATIVE_CONTEXT_STORE.get(nativeContext);

            if (backupNativeContext !== undefined) {
              return backupNativeContext;
            } // @todo Copy the attached AudioWorkletProcessors and other settings.


            const bckpNtveCntxt = new nativeAudioContextConstructor();
            BACKUP_NATIVE_CONTEXT_STORE.set(nativeContext, bckpNtveCntxt);
            return bckpNtveCntxt;
          }
        }

        return null;
      };
    };

    const createInvalidStateError = () => {
      try {
        return new DOMException('', 'InvalidStateError');
      } catch (err) {
        // Bug #122: Edge is the only browser that does not yet allow to construct a DOMException.
        err.code = 11;
        err.name = 'InvalidStateError';
        return err;
      }
    };

    const createGetNativeContext = contextStore => {
      return context => {
        const nativeContext = contextStore.get(context);

        if (nativeContext === undefined) {
          throw createInvalidStateError();
        }

        return nativeContext;
      };
    };

    const createGetUnrenderedAudioWorkletNodes = unrenderedAudioWorkletNodeStore => {
      return nativeContext => {
        const unrenderedAudioWorkletNodes = unrenderedAudioWorkletNodeStore.get(nativeContext);

        if (unrenderedAudioWorkletNodes === undefined) {
          throw new Error('The context has no set of AudioWorkletNodes.');
        }

        return unrenderedAudioWorkletNodes;
      };
    };

    const createInvalidAccessError = () => {
      try {
        return new DOMException('', 'InvalidAccessError');
      } catch (err) {
        // Bug #122: Edge is the only browser that does not yet allow to construct a DOMException.
        err.code = 15;
        err.name = 'InvalidAccessError';
        return err;
      }
    };

    const wrapIIRFilterNodeGetFrequencyResponseMethod = nativeIIRFilterNode => {
      nativeIIRFilterNode.getFrequencyResponse = (getFrequencyResponse => {
        return (frequencyHz, magResponse, phaseResponse) => {
          if (frequencyHz.length !== magResponse.length || magResponse.length !== phaseResponse.length) {
            throw createInvalidAccessError();
          }

          return getFrequencyResponse.call(nativeIIRFilterNode, frequencyHz, magResponse, phaseResponse);
        };
      })(nativeIIRFilterNode.getFrequencyResponse);
    };

    const DEFAULT_OPTIONS$c = {
      channelCount: 2,
      channelCountMode: 'max',
      channelInterpretation: 'speakers'
    };
    const createIIRFilterNodeConstructor = (audioNodeConstructor, createNativeIIRFilterNode, createIIRFilterNodeRenderer, getNativeContext, isNativeOfflineAudioContext) => {
      return class IIRFilterNode extends audioNodeConstructor {
        constructor(context, options) {
          const nativeContext = getNativeContext(context);
          const isOffline = isNativeOfflineAudioContext(nativeContext);
          const mergedOptions = { ...DEFAULT_OPTIONS$c,
            ...options
          };
          const nativeIIRFilterNode = createNativeIIRFilterNode(nativeContext, isOffline ? null : context.baseLatency, mergedOptions);
          const iirFilterNodeRenderer = isOffline ? createIIRFilterNodeRenderer(mergedOptions.feedback, mergedOptions.feedforward) : null;
          super(context, false, nativeIIRFilterNode, iirFilterNodeRenderer); // Bug #23 & #24: FirefoxDeveloper does not throw an InvalidAccessError.
          // @todo Write a test which allows other browsers to remain unpatched.

          wrapIIRFilterNodeGetFrequencyResponseMethod(nativeIIRFilterNode);
          this._nativeIIRFilterNode = nativeIIRFilterNode;
        }

        getFrequencyResponse(frequencyHz, magResponse, phaseResponse) {
          return this._nativeIIRFilterNode.getFrequencyResponse(frequencyHz, magResponse, phaseResponse);
        }

      };
    };

    // This implementation as shamelessly inspired by source code of
    // tslint:disable-next-line:max-line-length
    // {@link https://chromium.googlesource.com/chromium/src.git/+/master/third_party/WebKit/Source/platform/audio/IIRFilter.cpp|Chromium's IIRFilter}.
    const filterBuffer = (feedback, feedbackLength, feedforward, feedforwardLength, minLength, xBuffer, yBuffer, bufferIndex, bufferLength, input, output) => {
      const inputLength = input.length;
      let i = bufferIndex;

      for (let j = 0; j < inputLength; j += 1) {
        let y = feedforward[0] * input[j];

        for (let k = 1; k < minLength; k += 1) {
          const x = i - k & bufferLength - 1; // tslint:disable-line:no-bitwise

          y += feedforward[k] * xBuffer[x];
          y -= feedback[k] * yBuffer[x];
        }

        for (let k = minLength; k < feedforwardLength; k += 1) {
          y += feedforward[k] * xBuffer[i - k & bufferLength - 1]; // tslint:disable-line:no-bitwise
        }

        for (let k = minLength; k < feedbackLength; k += 1) {
          y -= feedback[k] * yBuffer[i - k & bufferLength - 1]; // tslint:disable-line:no-bitwise
        }

        xBuffer[i] = input[j];
        yBuffer[i] = y;
        i = i + 1 & bufferLength - 1; // tslint:disable-line:no-bitwise

        output[j] = y;
      }

      return i;
    };

    const filterFullBuffer = (renderedBuffer, nativeOfflineAudioContext, feedback, feedforward) => {
      const feedbackLength = feedback.length;
      const feedforwardLength = feedforward.length;
      const minLength = Math.min(feedbackLength, feedforwardLength);

      if (feedback[0] !== 1) {
        for (let i = 0; i < feedbackLength; i += 1) {
          feedforward[i] /= feedback[0];
        }

        for (let i = 1; i < feedforwardLength; i += 1) {
          feedback[i] /= feedback[0];
        }
      }

      const bufferLength = 32;
      const xBuffer = new Float32Array(bufferLength);
      const yBuffer = new Float32Array(bufferLength);
      const filteredBuffer = nativeOfflineAudioContext.createBuffer(renderedBuffer.numberOfChannels, renderedBuffer.length, renderedBuffer.sampleRate);
      const numberOfChannels = renderedBuffer.numberOfChannels;

      for (let i = 0; i < numberOfChannels; i += 1) {
        const input = renderedBuffer.getChannelData(i);
        const output = filteredBuffer.getChannelData(i);
        xBuffer.fill(0);
        yBuffer.fill(0);
        filterBuffer(feedback, feedbackLength, feedforward, feedforwardLength, minLength, xBuffer, yBuffer, 0, bufferLength, input, output);
      }

      return filteredBuffer;
    };

    const createIIRFilterNodeRendererFactory = (createNativeAudioBufferSourceNode, createNativeAudioNode, getNativeAudioNode, nativeOfflineAudioContextConstructor, renderInputsOfAudioNode, renderNativeOfflineAudioContext) => {
      return (feedback, feedforward) => {
        const renderedNativeAudioNodes = new WeakMap();
        let filteredBufferPromise = null;

        const createAudioNode = async (proxy, nativeOfflineAudioContext, trace) => {
          let nativeAudioBufferSourceNode = null;
          let nativeIIRFilterNode = getNativeAudioNode(proxy); // If the initially used nativeIIRFilterNode was not constructed on the same OfflineAudioContext it needs to be created again.

          const nativeIIRFilterNodeIsOwnedByContext = isOwnedByContext(nativeIIRFilterNode, nativeOfflineAudioContext); // Bug #9: Safari does not support IIRFilterNodes.

          if (nativeOfflineAudioContext.createIIRFilter === undefined) {
            nativeAudioBufferSourceNode = createNativeAudioBufferSourceNode(nativeOfflineAudioContext, {
              buffer: null,
              channelCount: 2,
              channelCountMode: 'max',
              channelInterpretation: 'speakers',
              loop: false,
              loopEnd: 0,
              loopStart: 0,
              playbackRate: 1
            });
          } else if (!nativeIIRFilterNodeIsOwnedByContext) {
            nativeIIRFilterNode = createNativeAudioNode(nativeOfflineAudioContext, ntvCntxt => {
              return ntvCntxt.createIIRFilter(feedforward, feedback);
            });
          }

          renderedNativeAudioNodes.set(nativeOfflineAudioContext, nativeAudioBufferSourceNode === null ? nativeIIRFilterNode : nativeAudioBufferSourceNode);

          if (nativeAudioBufferSourceNode !== null) {
            if (filteredBufferPromise === null) {
              if (nativeOfflineAudioContextConstructor === null) {
                throw new Error('Missing the native OfflineAudioContext constructor.');
              }

              const partialOfflineAudioContext = new nativeOfflineAudioContextConstructor( // Bug #47: The AudioDestinationNode in Edge and Safari gets not initialized correctly.
              proxy.context.destination.channelCount, // Bug #17: Safari does not yet expose the length.
              proxy.context.length, nativeOfflineAudioContext.sampleRate);

              filteredBufferPromise = (async () => {
                await renderInputsOfAudioNode(proxy, partialOfflineAudioContext, partialOfflineAudioContext.destination, trace);
                const renderedBuffer = await renderNativeOfflineAudioContext(partialOfflineAudioContext);
                return filterFullBuffer(renderedBuffer, nativeOfflineAudioContext, feedback, feedforward);
              })();
            }

            const filteredBuffer = await filteredBufferPromise;
            nativeAudioBufferSourceNode.buffer = filteredBuffer;
            nativeAudioBufferSourceNode.start(0);
            return nativeAudioBufferSourceNode;
          }

          await renderInputsOfAudioNode(proxy, nativeOfflineAudioContext, nativeIIRFilterNode, trace);
          return nativeIIRFilterNode;
        };

        return {
          render(proxy, nativeOfflineAudioContext, trace) {
            const renderedNativeAudioNode = renderedNativeAudioNodes.get(nativeOfflineAudioContext);

            if (renderedNativeAudioNode !== undefined) {
              return Promise.resolve(renderedNativeAudioNode);
            }

            return createAudioNode(proxy, nativeOfflineAudioContext, trace);
          }

        };
      };
    };

    const createIncrementCycleCounterFactory = (cycleCounters, disconnectNativeAudioNodeFromNativeAudioNode, getAudioNodeConnections, getNativeAudioNode, getNativeAudioParam, isActiveAudioNode) => {
      return isOffline => {
        return (audioNode, count) => {
          const cycleCounter = cycleCounters.get(audioNode);

          if (cycleCounter === undefined) {
            if (!isOffline && isActiveAudioNode(audioNode)) {
              const nativeSourceAudioNode = getNativeAudioNode(audioNode);
              const {
                outputs
              } = getAudioNodeConnections(audioNode);

              for (const output of outputs) {
                if (isAudioNodeOutputConnection(output)) {
                  const nativeDestinationAudioNode = getNativeAudioNode(output[0]);
                  disconnectNativeAudioNodeFromNativeAudioNode(nativeSourceAudioNode, nativeDestinationAudioNode, output[1], output[2]);
                } else {
                  const nativeDestinationAudioParam = getNativeAudioParam(output[0]);
                  nativeSourceAudioNode.disconnect(nativeDestinationAudioParam, output[1]);
                }
              }
            }

            cycleCounters.set(audioNode, count);
          } else {
            cycleCounters.set(audioNode, cycleCounter + count);
          }
        };
      };
    };

    const createIsAnyAudioContext = (contextStore, isNativeAudioContext) => {
      return anything => {
        const nativeContext = contextStore.get(anything);
        return isNativeAudioContext(nativeContext) || isNativeAudioContext(anything);
      };
    };

    const createIsAnyAudioNode = (audioNodeStore, isNativeAudioNode) => {
      return anything => audioNodeStore.has(anything) || isNativeAudioNode(anything);
    };

    const createIsAnyAudioParam = (audioParamStore, isNativeAudioParam) => {
      return anything => audioParamStore.has(anything) || isNativeAudioParam(anything);
    };

    const createIsAnyOfflineAudioContext = (contextStore, isNativeOfflineAudioContext) => {
      return anything => {
        const nativeContext = contextStore.get(anything);
        return isNativeOfflineAudioContext(nativeContext) || isNativeOfflineAudioContext(anything);
      };
    };

    const createIsNativeAudioContext = nativeAudioContextConstructor => {
      return anything => {
        return nativeAudioContextConstructor !== null && anything instanceof nativeAudioContextConstructor;
      };
    };

    const createIsNativeAudioNode = window => {
      return anything => {
        return window !== null && typeof window.AudioNode === 'function' && anything instanceof window.AudioNode;
      };
    };

    const createIsNativeAudioParam = window => {
      return anything => {
        return window !== null && typeof window.AudioParam === 'function' && anything instanceof window.AudioParam;
      };
    };

    const createIsNativeContext = (isNativeAudioContext, isNativeOfflineAudioContext) => {
      return anything => {
        return isNativeAudioContext(anything) || isNativeOfflineAudioContext(anything);
      };
    };

    const createIsNativeOfflineAudioContext = nativeOfflineAudioContextConstructor => {
      return anything => {
        return nativeOfflineAudioContextConstructor !== null && anything instanceof nativeOfflineAudioContextConstructor;
      };
    };

    const createIsSecureContext = window => window !== null && window.isSecureContext;

    const createIsSupportedPromise = async (cacheTestResult, testAudioBufferCopyChannelMethodsSubarraySupport, testAudioContextCloseMethodSupport, testAudioContextDecodeAudioDataMethodTypeErrorSupport, testAudioContextOptionsSupport, testAudioNodeConnectMethodSupport, testAudioWorkletProcessorNoOutputsSupport, testChannelMergerNodeChannelCountSupport, testConstantSourceNodeAccurateSchedulingSupport, testConvolverNodeBufferReassignabilitySupport, testIsSecureContextSupport, testMediaStreamAudioSourceNodeMediaStreamWithoutAudioTrackSupport, testStereoPannerNodeDefaultValueSupport, testTransferablesSupport) => {
      if (cacheTestResult(testAudioBufferCopyChannelMethodsSubarraySupport, testAudioBufferCopyChannelMethodsSubarraySupport) && cacheTestResult(testAudioContextCloseMethodSupport, testAudioContextCloseMethodSupport) && cacheTestResult(testAudioContextOptionsSupport, testAudioContextOptionsSupport) && cacheTestResult(testAudioNodeConnectMethodSupport, testAudioNodeConnectMethodSupport) && cacheTestResult(testChannelMergerNodeChannelCountSupport, testChannelMergerNodeChannelCountSupport) && cacheTestResult(testConstantSourceNodeAccurateSchedulingSupport, testConstantSourceNodeAccurateSchedulingSupport) && cacheTestResult(testConvolverNodeBufferReassignabilitySupport, testConvolverNodeBufferReassignabilitySupport) && cacheTestResult(testIsSecureContextSupport, testIsSecureContextSupport) && cacheTestResult(testMediaStreamAudioSourceNodeMediaStreamWithoutAudioTrackSupport, testMediaStreamAudioSourceNodeMediaStreamWithoutAudioTrackSupport)) {
        const results = await Promise.all([cacheTestResult(testAudioContextDecodeAudioDataMethodTypeErrorSupport, testAudioContextDecodeAudioDataMethodTypeErrorSupport), cacheTestResult(testAudioWorkletProcessorNoOutputsSupport, testAudioWorkletProcessorNoOutputsSupport), cacheTestResult(testStereoPannerNodeDefaultValueSupport, testStereoPannerNodeDefaultValueSupport), cacheTestResult(testTransferablesSupport, testTransferablesSupport)]);
        return results.every(result => result);
      }

      return false;
    };

    const createMediaElementAudioSourceNodeConstructor = (audioNodeConstructor, createNativeMediaElementAudioSourceNode, getNativeContext, isNativeOfflineAudioContext) => {
      return class MediaElementAudioSourceNode extends audioNodeConstructor {
        constructor(context, options) {
          const nativeContext = getNativeContext(context);
          const nativeMediaElementAudioSourceNode = createNativeMediaElementAudioSourceNode(nativeContext, options); // Bug #171: Safari allows to create a MediaElementAudioSourceNode with an OfflineAudioContext.

          if (isNativeOfflineAudioContext(nativeContext)) {
            throw TypeError();
          }

          super(context, true, nativeMediaElementAudioSourceNode, null); // Bug #63: Edge does not expose the mediaElement yet.

          this._mediaElement = options.mediaElement;
          this._nativeMediaElementAudioSourceNode = nativeMediaElementAudioSourceNode;
        }

        get mediaElement() {
          return this._nativeMediaElementAudioSourceNode.mediaElement === undefined ? this._mediaElement : this._nativeMediaElementAudioSourceNode.mediaElement;
        }

      };
    };

    const DEFAULT_OPTIONS$d = {
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers'
    };
    const createMediaStreamAudioDestinationNodeConstructor = (audioNodeConstructor, createNativeMediaStreamAudioDestinationNode, getNativeContext, isNativeOfflineAudioContext) => {
      return class MediaStreamAudioDestinationNode extends audioNodeConstructor {
        constructor(context, options = DEFAULT_OPTIONS$d) {
          const nativeContext = getNativeContext(context); // Bug #173: Safari allows to create a MediaStreamAudioDestinationNode with an OfflineAudioContext.

          if (isNativeOfflineAudioContext(nativeContext)) {
            throw new TypeError();
          }

          const mergedOptions = { ...DEFAULT_OPTIONS$d,
            ...options
          };
          const nativeMediaStreamAudioDestinationNode = createNativeMediaStreamAudioDestinationNode(nativeContext, mergedOptions);
          super(context, false, nativeMediaStreamAudioDestinationNode, null);
          this._nativeMediaStreamAudioDestinationNode = nativeMediaStreamAudioDestinationNode;
        }

        get stream() {
          return this._nativeMediaStreamAudioDestinationNode.stream;
        }

      };
    };

    const createMediaStreamAudioSourceNodeConstructor = (audioNodeConstructor, createNativeMediaStreamAudioSourceNode, getNativeContext, isNativeOfflineAudioContext) => {
      return class MediaStreamAudioSourceNode extends audioNodeConstructor {
        constructor(context, options) {
          const nativeContext = getNativeContext(context);
          const nativeMediaStreamAudioSourceNode = createNativeMediaStreamAudioSourceNode(nativeContext, options); // Bug #172: Safari allows to create a MediaStreamAudioSourceNode with an OfflineAudioContext.

          if (isNativeOfflineAudioContext(nativeContext)) {
            throw new TypeError();
          }

          super(context, true, nativeMediaStreamAudioSourceNode, null);
          this._nativeMediaStreamAudioSourceNode = nativeMediaStreamAudioSourceNode;
        }

        get mediaStream() {
          return this._nativeMediaStreamAudioSourceNode.mediaStream;
        }

      };
    };

    const createMediaStreamTrackAudioSourceNodeConstructor = (audioNodeConstructor, createNativeMediaStreamTrackAudioSourceNode, getNativeContext) => {
      return class MediaStreamTrackAudioSourceNode extends audioNodeConstructor {
        constructor(context, options) {
          const nativeContext = getNativeContext(context);
          const nativeMediaStreamTrackAudioSourceNode = createNativeMediaStreamTrackAudioSourceNode(nativeContext, options);
          super(context, true, nativeMediaStreamTrackAudioSourceNode, null);
        }

      };
    };

    const createMinimalAudioContextConstructor = (createInvalidStateError, createNotSupportedError, createUnknownError, minimalBaseAudioContextConstructor, nativeAudioContextConstructor) => {
      return class MinimalAudioContext extends minimalBaseAudioContextConstructor {
        constructor(options = {}) {
          if (nativeAudioContextConstructor === null) {
            throw new Error('Missing the native AudioContext constructor.');
          }

          const nativeAudioContext = new nativeAudioContextConstructor(options); // Bug #131 Safari returns null when there are four other AudioContexts running already.

          if (nativeAudioContext === null) {
            throw createUnknownError();
          } // Bug #51 Only Chrome and Opera throw an error if the given latencyHint is invalid.


          if (!isValidLatencyHint(options.latencyHint)) {
            throw new TypeError(`The provided value '${options.latencyHint}' is not a valid enum value of type AudioContextLatencyCategory.`);
          } // Bug #150 Only Chrome, Firefox and Opera support setting the sampleRate.


          if (options.sampleRate !== undefined && nativeAudioContext.sampleRate !== options.sampleRate) {
            throw createNotSupportedError();
          }

          super(nativeAudioContext, 2);
          const {
            latencyHint
          } = options;
          const {
            sampleRate
          } = nativeAudioContext; // @todo The values for 'balanced', 'interactive' and 'playback' are just copied from Chrome's implementation.

          this._baseLatency = typeof nativeAudioContext.baseLatency === 'number' ? nativeAudioContext.baseLatency : latencyHint === 'balanced' ? 512 / sampleRate : latencyHint === 'interactive' || latencyHint === undefined ? 256 / sampleRate : latencyHint === 'playback' ? 1024 / sampleRate :
          /*
           * @todo The min (256) and max (16384) values are taken from the allowed bufferSize values of a
           * ScriptProcessorNode.
           */
          Math.max(2, Math.min(128, Math.round(latencyHint * sampleRate / 128))) * 128 / sampleRate;
          this._nativeAudioContext = nativeAudioContext;
          this._state = null;
          /*
           * Bug #34: Chrome and Opera pretend to be running right away, but fire an onstatechange event when the state actually
           * changes to 'running'.
           */

          if (nativeAudioContext.state === 'running') {
            this._state = 'suspended';

            const revokeState = () => {
              if (this._state === 'suspended') {
                this._state = null;
              }

              nativeAudioContext.removeEventListener('statechange', revokeState);
            };

            nativeAudioContext.addEventListener('statechange', revokeState);
          }
        }

        get baseLatency() {
          return this._baseLatency;
        }

        get state() {
          return this._state !== null ? this._state : this._nativeAudioContext.state;
        }

        close() {
          // Bug #35: Firefox does not throw an error if the AudioContext was closed before.
          if (this.state === 'closed') {
            return this._nativeAudioContext.close().then(() => {
              throw createInvalidStateError();
            });
          } // Bug #34: If the state was set to suspended before it should be revoked now.


          if (this._state === 'suspended') {
            this._state = null;
          }

          return this._nativeAudioContext.close();
          /*
           * Bug #50: Deleting the AudioGraph is currently not possible anymore.
           * ...then(() => deleteAudioGraph(this, this._nativeAudioContext));
           */
        }

        resume() {
          if (this._state === 'suspended') {
            return new Promise((resolve, reject) => {
              const resolvePromise = () => {
                this._nativeAudioContext.removeEventListener('statechange', resolvePromise);

                if (this._nativeAudioContext.state === 'running') {
                  resolve();
                } else {
                  this.resume().then(resolve, reject);
                }
              };

              this._nativeAudioContext.addEventListener('statechange', resolvePromise);
            });
          }

          return this._nativeAudioContext.resume().catch(err => {
            // Bug #55: Chrome, Edge and Opera do throw an InvalidAccessError instead of an InvalidStateError.
            // Bug #56: Safari invokes the catch handler but without an error.
            if (err === undefined || err.code === 15) {
              throw createInvalidStateError();
            }

            throw err;
          });
        }

        suspend() {
          return this._nativeAudioContext.suspend().catch(err => {
            // Bug #56: Safari invokes the catch handler but without an error.
            if (err === undefined) {
              throw createInvalidStateError();
            }

            throw err;
          });
        }

      };
    };

    const createMinimalBaseAudioContextConstructor = (audioDestinationNodeConstructor, createAudioListener, eventTargetConstructor, isNativeOfflineAudioContext, unrenderedAudioWorkletNodeStore, wrapEventListener) => {
      return class MinimalBaseAudioContext extends eventTargetConstructor {
        constructor(_nativeContext, numberOfChannels) {
          super(_nativeContext);
          this._nativeContext = _nativeContext;
          CONTEXT_STORE.set(this, _nativeContext); // Bug #93: Edge will set the sampleRate of an AudioContext to zero when it is closed.

          const sampleRate = _nativeContext.sampleRate;
          Object.defineProperty(_nativeContext, 'sampleRate', {
            get: () => sampleRate
          });

          if (isNativeOfflineAudioContext(_nativeContext)) {
            unrenderedAudioWorkletNodeStore.set(_nativeContext, new Set());
          }

          this._destination = new audioDestinationNodeConstructor(this, numberOfChannels);
          this._listener = createAudioListener(this, _nativeContext);
          this._onstatechange = null;
        }

        get currentTime() {
          return this._nativeContext.currentTime;
        }

        get destination() {
          return this._destination;
        }

        get listener() {
          return this._listener;
        }

        get onstatechange() {
          return this._onstatechange;
        }

        set onstatechange(value) {
          const wrappedListener = typeof value === 'function' ? wrapEventListener(this, value) : null;
          this._nativeContext.onstatechange = wrappedListener;
          const nativeOnStateChange = this._nativeContext.onstatechange;
          this._onstatechange = nativeOnStateChange !== null && nativeOnStateChange === wrappedListener ? value : nativeOnStateChange;
        }

        get sampleRate() {
          return this._nativeContext.sampleRate;
        }

        get state() {
          return this._nativeContext.state;
        }

      };
    };

    const testPromiseSupport = nativeContext => {
      // This 12 numbers represent the 48 bytes of an empty WAVE file with a single sample.
      const uint32Array = new Uint32Array([1179011410, 40, 1163280727, 544501094, 16, 131073, 44100, 176400, 1048580, 1635017060, 4, 0]);

      try {
        // Bug #1: Safari requires a successCallback.
        const promise = nativeContext.decodeAudioData(uint32Array.buffer, () => {// Ignore the success callback.
        });

        if (promise === undefined) {
          return false;
        }

        promise.catch(() => {// Ignore rejected errors.
        });
        return true;
      } catch {// Ignore errors.
      }

      return false;
    };

    const DEFAULT_OPTIONS$e = {
      numberOfChannels: 1
    };
    const createMinimalOfflineAudioContextConstructor = (cacheTestResult, createInvalidStateError, createNativeOfflineAudioContext, minimalBaseAudioContextConstructor, startRendering) => {
      return class MinimalOfflineAudioContext extends minimalBaseAudioContextConstructor {
        constructor(options) {
          const {
            length,
            numberOfChannels,
            sampleRate
          } = { ...DEFAULT_OPTIONS$e,
            ...options
          };
          const nativeOfflineAudioContext = createNativeOfflineAudioContext(numberOfChannels, length, sampleRate); // #21 Safari does not support promises and therefore would fire the statechange event before the promise can be resolved.

          if (!cacheTestResult(testPromiseSupport, () => testPromiseSupport(nativeOfflineAudioContext))) {
            nativeOfflineAudioContext.addEventListener('statechange', (() => {
              let i = 0;

              const delayStateChangeEvent = event => {
                if (this._state === 'running') {
                  if (i > 0) {
                    nativeOfflineAudioContext.removeEventListener('statechange', delayStateChangeEvent);
                    event.stopImmediatePropagation();

                    this._waitForThePromiseToSettle(event);
                  } else {
                    i += 1;
                  }
                }
              };

              return delayStateChangeEvent;
            })());
          }

          super(nativeOfflineAudioContext, numberOfChannels);
          this._length = length;
          this._nativeOfflineAudioContext = nativeOfflineAudioContext;
          this._state = null;
        }

        get length() {
          // Bug #17: Safari does not yet expose the length.
          if (this._nativeOfflineAudioContext.length === undefined) {
            return this._length;
          }

          return this._nativeOfflineAudioContext.length;
        }

        get state() {
          return this._state === null ? this._nativeOfflineAudioContext.state : this._state;
        }

        startRendering() {
          /*
           * Bug #9 & #59: It is theoretically possible that startRendering() will first render a partialOfflineAudioContext. Therefore
           * the state of the nativeOfflineAudioContext might no transition to running immediately.
           */
          if (this._state === 'running') {
            return Promise.reject(createInvalidStateError());
          }

          this._state = 'running';
          return startRendering(this.destination, this._nativeOfflineAudioContext).then(audioBuffer => {
            this._state = null;
            /*
             * Bug #50: Deleting the AudioGraph is currently not possible anymore.
             * deleteAudioGraph(this, this._nativeOfflineAudioContext);
             */

            return audioBuffer;
          }) // @todo This could be written more elegantly when Promise.finally() becomes avalaible.
          .catch(err => {
            this._state = null;
            /*
             * Bug #50: Deleting the AudioGraph is currently not possible anymore.
             * deleteAudioGraph(this, this._nativeOfflineAudioContext);
             */

            throw err;
          });
        }

        _waitForThePromiseToSettle(event) {
          if (this._state === null) {
            this._nativeOfflineAudioContext.dispatchEvent(event);
          } else {
            setTimeout(() => this._waitForThePromiseToSettle(event));
          }
        }

      };
    };

    const createMonitorConnections = (insertElementInSet, isNativeAudioNode) => {
      return (nativeAudioNode, whenConnected, whenDisconnected) => {
        const connections = new Set();

        nativeAudioNode.connect = (connect => {
          // tslint:disable-next-line:invalid-void
          return (destination, output = 0, input = 0) => {
            const wasDisconnected = connections.size === 0;

            if (isNativeAudioNode(destination)) {
              // @todo TypeScript cannot infer the overloaded signature with 3 arguments yet.
              connect.call(nativeAudioNode, destination, output, input);
              insertElementInSet(connections, [destination, output, input], connection => connection[0] === destination && connection[1] === output && connection[2] === input, true);

              if (wasDisconnected) {
                whenConnected();
              }

              return destination;
            }

            connect.call(nativeAudioNode, destination, output);
            insertElementInSet(connections, [destination, output], connection => connection[0] === destination && connection[1] === output, true);

            if (wasDisconnected) {
              whenConnected();
            }

            return;
          };
        })(nativeAudioNode.connect);

        nativeAudioNode.disconnect = (disconnect => {
          return (destinationOrOutput, output, input) => {
            const wasConnected = connections.size > 0;

            if (destinationOrOutput === undefined) {
              disconnect.apply(nativeAudioNode);
              connections.clear();
            } else if (typeof destinationOrOutput === 'number') {
              // @todo TypeScript cannot infer the overloaded signature with 1 argument yet.
              disconnect.call(nativeAudioNode, destinationOrOutput);

              for (const connection of connections) {
                if (connection[1] === destinationOrOutput) {
                  connections.delete(connection);
                }
              }
            } else {
              if (isNativeAudioNode(destinationOrOutput)) {
                // @todo TypeScript cannot infer the overloaded signature with 3 arguments yet.
                disconnect.call(nativeAudioNode, destinationOrOutput, output, input);
              } else {
                // @todo TypeScript cannot infer the overloaded signature with 2 arguments yet.
                disconnect.call(nativeAudioNode, destinationOrOutput, output);
              }

              for (const connection of connections) {
                if (connection[0] === destinationOrOutput && (output === undefined || connection[1] === output) && (input === undefined || connection[2] === input)) {
                  connections.delete(connection);
                }
              }
            }

            const isDisconnected = connections.size === 0;

            if (wasConnected && isDisconnected) {
              whenDisconnected();
            }
          };
        })(nativeAudioNode.disconnect);

        return nativeAudioNode;
      };
    };

    const assignNativeAudioNodeOption = (nativeAudioNode, options, option) => {
      const value = options[option];

      if (value !== undefined && value !== nativeAudioNode[option]) {
        nativeAudioNode[option] = value;
      }
    };

    const assignNativeAudioNodeOptions = (nativeAudioNode, options) => {
      assignNativeAudioNodeOption(nativeAudioNode, options, 'channelCount');
      assignNativeAudioNodeOption(nativeAudioNode, options, 'channelCountMode');
      assignNativeAudioNodeOption(nativeAudioNode, options, 'channelInterpretation');
    };

    const testAnalyserNodeGetFloatTimeDomainDataMethodSupport = nativeAnalyserNode => {
      return typeof nativeAnalyserNode.getFloatTimeDomainData === 'function';
    };

    const wrapAnalyserNodeGetFloatTimeDomainDataMethod = nativeAnalyserNode => {
      nativeAnalyserNode.getFloatTimeDomainData = array => {
        const byteTimeDomainData = new Uint8Array(array.length);
        nativeAnalyserNode.getByteTimeDomainData(byteTimeDomainData);
        const length = Math.max(byteTimeDomainData.length, nativeAnalyserNode.fftSize);

        for (let i = 0; i < length; i += 1) {
          array[i] = (byteTimeDomainData[i] - 128) * 0.0078125;
        }

        return array;
      };
    };

    const createNativeAnalyserNodeFactory = (cacheTestResult, createIndexSizeError, createNativeAudioNode) => {
      return (nativeContext, options) => {
        const nativeAnalyserNode = createNativeAudioNode(nativeContext, ntvCntxt => ntvCntxt.createAnalyser()); // Bug #37: Firefox does not create an AnalyserNode with the default properties.

        assignNativeAudioNodeOptions(nativeAnalyserNode, options); // Bug #118: Safari does not throw an error if maxDecibels is not more than minDecibels.

        if (!(options.maxDecibels > options.minDecibels)) {
          throw createIndexSizeError();
        }

        assignNativeAudioNodeOption(nativeAnalyserNode, options, 'fftSize');
        assignNativeAudioNodeOption(nativeAnalyserNode, options, 'maxDecibels');
        assignNativeAudioNodeOption(nativeAnalyserNode, options, 'minDecibels');
        assignNativeAudioNodeOption(nativeAnalyserNode, options, 'smoothingTimeConstant'); // Bug #36: Safari does not support getFloatTimeDomainData() yet.

        if (!cacheTestResult(testAnalyserNodeGetFloatTimeDomainDataMethodSupport, () => testAnalyserNodeGetFloatTimeDomainDataMethodSupport(nativeAnalyserNode))) {
          wrapAnalyserNodeGetFloatTimeDomainDataMethod(nativeAnalyserNode);
        }

        return nativeAnalyserNode;
      };
    };

    const createNativeAudioBufferConstructor = window => {
      if (window === null) {
        return null;
      }

      if (window.hasOwnProperty('AudioBuffer')) {
        return window.AudioBuffer;
      }

      return null;
    };

    const assignNativeAudioNodeAudioParamValue = (nativeAudioNode, options, audioParam) => {
      const value = options[audioParam];

      if (value !== undefined && value !== nativeAudioNode[audioParam].value) {
        nativeAudioNode[audioParam].value = value;
      }
    };

    const wrapAudioBufferSourceNodeStartMethodConsecutiveCalls = nativeAudioBufferSourceNode => {
      nativeAudioBufferSourceNode.start = (start => {
        let isScheduled = false;
        return (when = 0, offset = 0, duration) => {
          if (isScheduled) {
            throw createInvalidStateError();
          }

          start.call(nativeAudioBufferSourceNode, when, offset, duration);
          isScheduled = true;
        };
      })(nativeAudioBufferSourceNode.start);
    };

    const wrapAudioBufferSourceNodeStartMethodDurationParameter = (nativeAudioScheduledSourceNode, nativeContext) => {
      let endTime = Number.POSITIVE_INFINITY;
      let stopTime = Number.POSITIVE_INFINITY;

      nativeAudioScheduledSourceNode.start = ((start, stop) => {
        return (when = 0, offset = 0, duration = Number.POSITIVE_INFINITY) => {
          start.call(nativeAudioScheduledSourceNode, when, offset);

          if (duration >= 0 && duration < Number.POSITIVE_INFINITY) {
            const actualStartTime = Math.max(when, nativeContext.currentTime); // @todo The playbackRate could of course also have been automated and is not always fixed.

            const durationInBufferTime = duration / nativeAudioScheduledSourceNode.playbackRate.value;
            endTime = actualStartTime + durationInBufferTime;
            stop.call(nativeAudioScheduledSourceNode, Math.min(endTime, stopTime));
          }
        };
      })(nativeAudioScheduledSourceNode.start, nativeAudioScheduledSourceNode.stop);

      nativeAudioScheduledSourceNode.stop = (stop => {
        return (when = 0) => {
          stopTime = Math.max(when, nativeContext.currentTime);
          stop.call(nativeAudioScheduledSourceNode, Math.min(endTime, stopTime));
        };
      })(nativeAudioScheduledSourceNode.stop);
    };

    const wrapAudioScheduledSourceNodeStartMethodNegativeParameters = nativeAudioScheduledSourceNode => {
      nativeAudioScheduledSourceNode.start = (start => {
        return (when = 0, offset = 0, duration) => {
          if (typeof duration === 'number' && duration < 0 || offset < 0 || when < 0) {
            throw new RangeError("The parameters can't be negative.");
          } // @todo TypeScript cannot infer the overloaded signature with 3 arguments yet.


          start.call(nativeAudioScheduledSourceNode, when, offset, duration);
        };
      })(nativeAudioScheduledSourceNode.start);
    };

    const wrapAudioScheduledSourceNodeStopMethodNegativeParameters = nativeAudioScheduledSourceNode => {
      nativeAudioScheduledSourceNode.stop = (stop => {
        return (when = 0) => {
          if (when < 0) {
            throw new RangeError("The parameter can't be negative.");
          }

          stop.call(nativeAudioScheduledSourceNode, when);
        };
      })(nativeAudioScheduledSourceNode.stop);
    };

    const createNativeAudioBufferSourceNodeFactory = (addSilentConnection, cacheTestResult, createNativeAudioNode, testAudioBufferSourceNodeStartMethodConsecutiveCallsSupport, testAudioBufferSourceNodeStartMethodDurationParameterSupport, testAudioBufferSourceNodeStartMethodOffsetClampingSupport, testAudioBufferSourceNodeStopMethodNullifiedBufferSupport, testAudioScheduledSourceNodeStartMethodNegativeParametersSupport, testAudioScheduledSourceNodeStopMethodConsecutiveCallsSupport, testAudioScheduledSourceNodeStopMethodNegativeParametersSupport, wrapAudioBufferSourceNodeStartMethodOffsetClampling, wrapAudioBufferSourceNodeStopMethodNullifiedBuffer, wrapAudioScheduledSourceNodeStopMethodConsecutiveCalls) => {
      return (nativeContext, options) => {
        const nativeAudioBufferSourceNode = createNativeAudioNode(nativeContext, ntvCntxt => ntvCntxt.createBufferSource());
        assignNativeAudioNodeOptions(nativeAudioBufferSourceNode, options);
        assignNativeAudioNodeAudioParamValue(nativeAudioBufferSourceNode, options, 'playbackRate'); // Bug #71: Edge does not allow to set the buffer to null.

        assignNativeAudioNodeOption(nativeAudioBufferSourceNode, options, 'buffer'); // Bug #149: Safari does not yet support the detune AudioParam.

        assignNativeAudioNodeOption(nativeAudioBufferSourceNode, options, 'loop');
        assignNativeAudioNodeOption(nativeAudioBufferSourceNode, options, 'loopEnd');
        assignNativeAudioNodeOption(nativeAudioBufferSourceNode, options, 'loopStart'); // Bug #69: Safari does allow calls to start() of an already scheduled AudioBufferSourceNode.

        if (!cacheTestResult(testAudioBufferSourceNodeStartMethodConsecutiveCallsSupport, () => testAudioBufferSourceNodeStartMethodConsecutiveCallsSupport(nativeContext))) {
          wrapAudioBufferSourceNodeStartMethodConsecutiveCalls(nativeAudioBufferSourceNode);
        } // Bug #92: Chrome & Edge do not respect the duration parameter yet.


        if (!cacheTestResult(testAudioBufferSourceNodeStartMethodDurationParameterSupport, testAudioBufferSourceNodeStartMethodDurationParameterSupport)) {
          wrapAudioBufferSourceNodeStartMethodDurationParameter(nativeAudioBufferSourceNode, nativeContext);
        } // Bug #154 & #155: Safari does not handle offsets which are equal to or greater than the duration of the buffer.


        if (!cacheTestResult(testAudioBufferSourceNodeStartMethodOffsetClampingSupport, () => testAudioBufferSourceNodeStartMethodOffsetClampingSupport(nativeContext))) {
          wrapAudioBufferSourceNodeStartMethodOffsetClampling(nativeAudioBufferSourceNode);
        } // Bug #162: Safari does throw an error when stop() is called on an AudioBufferSourceNode which has no buffer assigned to it.


        if (!cacheTestResult(testAudioBufferSourceNodeStopMethodNullifiedBufferSupport, () => testAudioBufferSourceNodeStopMethodNullifiedBufferSupport(nativeContext))) {
          wrapAudioBufferSourceNodeStopMethodNullifiedBuffer(nativeAudioBufferSourceNode, nativeContext);
        } // Bug #44: Only Chrome, Firefox & Opera throw a RangeError yet.


        if (!cacheTestResult(testAudioScheduledSourceNodeStartMethodNegativeParametersSupport, () => testAudioScheduledSourceNodeStartMethodNegativeParametersSupport(nativeContext))) {
          wrapAudioScheduledSourceNodeStartMethodNegativeParameters(nativeAudioBufferSourceNode);
        } // Bug #19: Safari does not ignore calls to stop() of an already stopped AudioBufferSourceNode.


        if (!cacheTestResult(testAudioScheduledSourceNodeStopMethodConsecutiveCallsSupport, () => testAudioScheduledSourceNodeStopMethodConsecutiveCallsSupport(nativeContext))) {
          wrapAudioScheduledSourceNodeStopMethodConsecutiveCalls(nativeAudioBufferSourceNode, nativeContext);
        } // Bug #44: Only Firefox does not throw a RangeError yet.


        if (!cacheTestResult(testAudioScheduledSourceNodeStopMethodNegativeParametersSupport, () => testAudioScheduledSourceNodeStopMethodNegativeParametersSupport(nativeContext))) {
          wrapAudioScheduledSourceNodeStopMethodNegativeParameters(nativeAudioBufferSourceNode);
        } // Bug #175: Safari will not fire an ended event if the AudioBufferSourceNode is unconnected.


        addSilentConnection(nativeContext, nativeAudioBufferSourceNode);
        return nativeAudioBufferSourceNode;
      };
    };

    const createNativeAudioContextConstructor = window => {
      if (window === null) {
        return null;
      }

      if (window.hasOwnProperty('AudioContext')) {
        return window.AudioContext;
      }

      return window.hasOwnProperty('webkitAudioContext') ? window.webkitAudioContext : null;
    };

    const createNativeAudioDestinationNodeFactory = (createNativeGainNode, overwriteAccessors) => {
      return (nativeContext, channelCount, isNodeOfNativeOfflineAudioContext) => {
        const nativeAudioDestinationNode = nativeContext.destination; // Bug #132: Edge & Safari do not have the correct channelCount.

        if (nativeAudioDestinationNode.channelCount !== channelCount) {
          try {
            nativeAudioDestinationNode.channelCount = channelCount;
          } catch {// Bug #169: Safari throws an error on each attempt to change the channelCount.
          }
        } // Bug #83: Edge & Safari do not have the correct channelCountMode.


        if (isNodeOfNativeOfflineAudioContext && nativeAudioDestinationNode.channelCountMode !== 'explicit') {
          nativeAudioDestinationNode.channelCountMode = 'explicit';
        } // Bug #47: The AudioDestinationNode in Edge and Safari does not initialize the maxChannelCount property correctly.


        if (nativeAudioDestinationNode.maxChannelCount === 0) {
          Object.defineProperty(nativeAudioDestinationNode, 'maxChannelCount', {
            value: channelCount
          });
        } // Bug #168: No browser does yet have an AudioDestinationNode with an output.


        const gainNode = createNativeGainNode(nativeContext, {
          channelCount,
          channelCountMode: nativeAudioDestinationNode.channelCountMode,
          channelInterpretation: nativeAudioDestinationNode.channelInterpretation,
          gain: 1
        });
        overwriteAccessors(gainNode, 'channelCount', get => () => get.call(gainNode), set => value => {
          set.call(gainNode, value);

          try {
            nativeAudioDestinationNode.channelCount = value;
          } catch (err) {
            // Bug #169: Safari throws an error on each attempt to change the channelCount.
            if (value > nativeAudioDestinationNode.maxChannelCount) {
              throw err;
            }
          }
        });
        overwriteAccessors(gainNode, 'channelCountMode', get => () => get.call(gainNode), set => value => {
          set.call(gainNode, value);
          nativeAudioDestinationNode.channelCountMode = value;
        });
        overwriteAccessors(gainNode, 'channelInterpretation', get => () => get.call(gainNode), set => value => {
          set.call(gainNode, value);
          nativeAudioDestinationNode.channelInterpretation = value;
        });
        Object.defineProperty(gainNode, 'maxChannelCount', {
          get: () => nativeAudioDestinationNode.maxChannelCount
        }); // @todo This should be disconnected when the context is closed.

        gainNode.connect(nativeAudioDestinationNode);
        return gainNode;
      };
    };

    const createNativeAudioNodeFactory = getBackupNativeContext => {
      return (nativeContext, factoryFunction) => {
        // Bug #50: Only Edge does currently not allow to create AudioNodes on a closed context yet.
        const backupNativeContext = getBackupNativeContext(nativeContext);

        if (backupNativeContext !== null) {
          return factoryFunction(backupNativeContext);
        }

        return factoryFunction(nativeContext);
      };
    };

    const createNativeAudioWorkletNodeConstructor = window => {
      if (window === null) {
        return null;
      }

      return window.hasOwnProperty('AudioWorkletNode') ? window.AudioWorkletNode : null;
    };

    const testClonabilityOfAudioWorkletNodeOptions = audioWorkletNodeOptions => {
      const {
        port1
      } = new MessageChannel();

      try {
        // This will throw an error if the audioWorkletNodeOptions are not clonable.
        port1.postMessage(audioWorkletNodeOptions);
      } finally {
        port1.close();
      }
    };

    const createNativeAudioWorkletNodeFactory = (createInvalidStateError, createNativeAudioNode, createNativeAudioWorkletNodeFaker, createNativeGainNode, createNotSupportedError, monitorConnections) => {
      return (nativeContext, baseLatency, nativeAudioWorkletNodeConstructor, name, processorConstructor, options) => {
        if (nativeAudioWorkletNodeConstructor !== null) {
          try {
            const nativeAudioWorkletNode = createNativeAudioNode(nativeContext, ntvCntxt => {
              return new nativeAudioWorkletNodeConstructor(ntvCntxt, name, options);
            });
            const patchedEventListeners = new Map();
            let onprocessorerror = null;
            Object.defineProperties(nativeAudioWorkletNode, {
              /*
               * Bug #61: Overwriting the property accessors for channelCount and channelCountMode is necessary as long as some
               * browsers have no native implementation to achieve a consistent behavior.
               */
              channelCount: {
                get: () => options.channelCount,
                set: () => {
                  throw createInvalidStateError();
                }
              },
              channelCountMode: {
                get: () => 'explicit',
                set: () => {
                  throw createInvalidStateError();
                }
              },
              // Bug #156: Chrome & Opera do not yet fire an ErrorEvent.
              onprocessorerror: {
                get: () => onprocessorerror,
                set: value => {
                  if (typeof onprocessorerror === 'function') {
                    nativeAudioWorkletNode.removeEventListener('processorerror', onprocessorerror);
                  }

                  onprocessorerror = typeof value === 'function' ? value : null;

                  if (typeof onprocessorerror === 'function') {
                    nativeAudioWorkletNode.addEventListener('processorerror', onprocessorerror);
                  }
                }
              }
            });

            nativeAudioWorkletNode.addEventListener = (addEventListener => {
              return (...args) => {
                if (args[0] === 'processorerror') {
                  const unpatchedEventListener = typeof args[1] === 'function' ? args[1] : typeof args[1] === 'object' && args[1] !== null && typeof args[1].handleEvent === 'function' ? args[1].handleEvent : null;

                  if (unpatchedEventListener !== null) {
                    const patchedEventListener = patchedEventListeners.get(args[1]);

                    if (patchedEventListener !== undefined) {
                      args[1] = patchedEventListener;
                    } else {
                      args[1] = event => {
                        unpatchedEventListener(new ErrorEvent(args[0], { ...event,
                          error: new Error()
                        }));
                      };

                      patchedEventListeners.set(unpatchedEventListener, args[1]);
                    }
                  }
                }

                return addEventListener.call(nativeAudioWorkletNode, args[0], args[1], args[2]);
              };
            })(nativeAudioWorkletNode.addEventListener);

            nativeAudioWorkletNode.removeEventListener = (removeEventListener => {
              return (...args) => {
                if (args[0] === 'processorerror') {
                  const patchedEventListener = patchedEventListeners.get(args[1]);

                  if (patchedEventListener !== undefined) {
                    patchedEventListeners.delete(args[1]);
                    args[1] = patchedEventListener;
                  }
                }

                return removeEventListener.call(nativeAudioWorkletNode, args[0], args[1], args[2]);
              };
            })(nativeAudioWorkletNode.removeEventListener);
            /*
             * Bug #86: Chrome & Opera do not invoke the process() function if the corresponding AudioWorkletNode is unconnected but has
             * an output.
             */


            if (options.numberOfOutputs !== 0) {
              const nativeGainNode = createNativeGainNode(nativeContext, {
                channelCount: 1,
                channelCountMode: 'explicit',
                channelInterpretation: 'discrete',
                gain: 0
              });
              nativeAudioWorkletNode.connect(nativeGainNode)
              /*
               * Bug #50: Edge does not yet allow to create AudioNodes on a closed AudioContext. Therefore the context property is
               * used here to make sure to connect the right destination.
               */
              .connect(nativeGainNode.context.destination);

              const whenConnected = () => nativeGainNode.disconnect();
              /*
               * Bug #50: Edge does not yet allow to create AudioNodes on a closed AudioContext. Therefore the context property is
               * used here to make sure to connect the right destination.
               */


              const whenDisconnected = () => nativeGainNode.connect(nativeGainNode.context.destination); // @todo Disconnect the connection when the process() function of the AudioWorkletNode returns false.


              return monitorConnections(nativeAudioWorkletNode, whenConnected, whenDisconnected);
            }

            return nativeAudioWorkletNode;
          } catch (err) {
            // Bug #60: Chrome & Opera throw an InvalidStateError instead of a NotSupportedError.
            if (err.code === 11) {
              throw createNotSupportedError();
            }

            throw err;
          }
        } // Bug #61: Only Chrome & Opera have an implementation of the AudioWorkletNode yet.


        if (processorConstructor === undefined) {
          throw createNotSupportedError();
        }

        testClonabilityOfAudioWorkletNodeOptions(options);
        return createNativeAudioWorkletNodeFaker(nativeContext, baseLatency, processorConstructor, options);
      };
    };

    const computeBufferSize = (baseLatency, sampleRate) => {
      if (baseLatency === null) {
        return 512;
      }

      return Math.max(512, Math.min(16384, Math.pow(2, Math.round(Math.log2(baseLatency * sampleRate)))));
    };

    const cloneAudioWorkletNodeOptions = audioWorkletNodeOptions => {
      return new Promise((resolve, reject) => {
        const {
          port1,
          port2
        } = new MessageChannel();

        port1.onmessage = ({
          data
        }) => {
          port1.close();
          port2.close();
          resolve(data);
        };

        port1.onmessageerror = ({
          data
        }) => {
          port1.close();
          port2.close();
          reject(data);
        }; // This will throw an error if the audioWorkletNodeOptions are not clonable.


        port2.postMessage(audioWorkletNodeOptions);
      });
    };

    const createAudioWorkletProcessorPromise = async (processorConstructor, audioWorkletNodeOptions) => {
      const clonedAudioWorkletNodeOptions = await cloneAudioWorkletNodeOptions(audioWorkletNodeOptions);
      return new processorConstructor(clonedAudioWorkletNodeOptions);
    };

    const createAudioWorkletProcessor = (nativeContext, nativeAudioWorkletNode, processorConstructor, audioWorkletNodeOptions) => {
      let nodeToProcessorMap = NODE_TO_PROCESSOR_MAPS.get(nativeContext);

      if (nodeToProcessorMap === undefined) {
        nodeToProcessorMap = new WeakMap();
        NODE_TO_PROCESSOR_MAPS.set(nativeContext, nodeToProcessorMap);
      }

      const audioWorkletProcessorPromise = createAudioWorkletProcessorPromise(processorConstructor, audioWorkletNodeOptions);
      nodeToProcessorMap.set(nativeAudioWorkletNode, audioWorkletProcessorPromise);
      return audioWorkletProcessorPromise;
    };

    const createNativeAudioWorkletNodeFakerFactory = (auxiliaryGainNodeStore, connectMultipleOutputs, createIndexSizeError, createInvalidStateError, createNativeChannelMergerNode, createNativeChannelSplitterNode, createNativeConstantSourceNode, createNativeGainNode, createNativeScriptProcessorNode, createNotSupportedError, disconnectMultipleOutputs, exposeCurrentFrameAndCurrentTime, monitorConnections) => {
      return (nativeContext, baseLatency, processorConstructor, options) => {
        if (options.numberOfInputs === 0 && options.numberOfOutputs === 0) {
          throw createNotSupportedError();
        }

        if (options.outputChannelCount !== undefined) {
          // @todo Check if any of the channelCount values is greater than the implementation's maximum number of channels.
          if (options.outputChannelCount.some(channelCount => channelCount < 1)) {
            throw createNotSupportedError();
          }

          if (options.outputChannelCount.length !== options.numberOfOutputs) {
            throw createIndexSizeError();
          }
        } // Bug #61: This is not part of the standard but required for the faker to work.


        if (options.channelCountMode !== 'explicit') {
          throw createNotSupportedError();
        }

        const numberOfInputChannels = options.channelCount * options.numberOfInputs;
        const numberOfOutputChannels = options.outputChannelCount.reduce((sum, value) => sum + value, 0);
        const numberOfParameters = processorConstructor.parameterDescriptors === undefined ? 0 : processorConstructor.parameterDescriptors.length; // Bug #61: This is not part of the standard but required for the faker to work.

        if (numberOfInputChannels + numberOfParameters > 6 || numberOfOutputChannels > 6) {
          throw createNotSupportedError();
        }

        const messageChannel = new MessageChannel();
        const gainNodes = [];
        const inputChannelSplitterNodes = [];

        for (let i = 0; i < options.numberOfInputs; i += 1) {
          gainNodes.push(createNativeGainNode(nativeContext, {
            channelCount: options.channelCount,
            channelCountMode: options.channelCountMode,
            channelInterpretation: options.channelInterpretation,
            gain: 1
          }));
          inputChannelSplitterNodes.push(createNativeChannelSplitterNode(nativeContext, {
            channelCount: options.channelCount,
            channelCountMode: 'explicit',
            channelInterpretation: 'discrete',
            numberOfOutputs: options.channelCount
          }));
        }

        const constantSourceNodes = [];

        if (processorConstructor.parameterDescriptors !== undefined) {
          for (const {
            defaultValue,
            maxValue,
            minValue,
            name
          } of processorConstructor.parameterDescriptors) {
            const constantSourceNode = createNativeConstantSourceNode(nativeContext, {
              channelCount: 1,
              channelCountMode: 'explicit',
              channelInterpretation: 'discrete',
              offset: options.parameterData[name] !== undefined ? options.parameterData[name] : defaultValue === undefined ? 0 : defaultValue
            });
            Object.defineProperties(constantSourceNode.offset, {
              defaultValue: {
                get: () => defaultValue === undefined ? 0 : defaultValue
              },
              maxValue: {
                get: () => maxValue === undefined ? MOST_POSITIVE_SINGLE_FLOAT : maxValue
              },
              minValue: {
                get: () => minValue === undefined ? MOST_NEGATIVE_SINGLE_FLOAT : minValue
              }
            });
            constantSourceNodes.push(constantSourceNode);
          }
        }

        const inputChannelMergerNode = createNativeChannelMergerNode(nativeContext, {
          channelCount: 1,
          channelCountMode: 'explicit',
          channelInterpretation: 'speakers',
          numberOfInputs: Math.max(1, numberOfInputChannels + numberOfParameters)
        });
        const bufferSize = computeBufferSize(baseLatency, nativeContext.sampleRate);
        const scriptProcessorNode = createNativeScriptProcessorNode(nativeContext, bufferSize, numberOfInputChannels + numberOfParameters, // Bug #87: Only Firefox will fire an AudioProcessingEvent if there is no connected output.
        Math.max(1, numberOfOutputChannels));
        const outputChannelSplitterNode = createNativeChannelSplitterNode(nativeContext, {
          channelCount: Math.max(1, numberOfOutputChannels),
          channelCountMode: 'explicit',
          channelInterpretation: 'discrete',
          numberOfOutputs: Math.max(1, numberOfOutputChannels)
        });
        const outputChannelMergerNodes = [];

        for (let i = 0; i < options.numberOfOutputs; i += 1) {
          outputChannelMergerNodes.push(createNativeChannelMergerNode(nativeContext, {
            channelCount: 1,
            channelCountMode: 'explicit',
            channelInterpretation: 'speakers',
            numberOfInputs: options.outputChannelCount[i]
          }));
        }

        for (let i = 0; i < options.numberOfInputs; i += 1) {
          gainNodes[i].connect(inputChannelSplitterNodes[i]);

          for (let j = 0; j < options.channelCount; j += 1) {
            inputChannelSplitterNodes[i].connect(inputChannelMergerNode, j, i * options.channelCount + j);
          }
        }

        const parameterMap = new ReadOnlyMap(processorConstructor.parameterDescriptors === undefined ? [] : processorConstructor.parameterDescriptors.map(({
          name
        }, index) => {
          const constantSourceNode = constantSourceNodes[index];
          constantSourceNode.connect(inputChannelMergerNode, 0, numberOfInputChannels + index);
          constantSourceNode.start(0);
          return [name, constantSourceNode.offset];
        }));
        inputChannelMergerNode.connect(scriptProcessorNode);
        let channelInterpretation = options.channelInterpretation;
        let onprocessorerror = null; // Bug #87: Expose at least one output to make this node connectable.

        const outputAudioNodes = options.numberOfOutputs === 0 ? [scriptProcessorNode] : outputChannelMergerNodes;
        const nativeAudioWorkletNodeFaker = {
          get bufferSize() {
            return bufferSize;
          },

          get channelCount() {
            return options.channelCount;
          },

          set channelCount(_) {
            // Bug #61: This is not part of the standard but required for the faker to work.
            throw createInvalidStateError();
          },

          get channelCountMode() {
            return options.channelCountMode;
          },

          set channelCountMode(_) {
            // Bug #61: This is not part of the standard but required for the faker to work.
            throw createInvalidStateError();
          },

          get channelInterpretation() {
            return channelInterpretation;
          },

          set channelInterpretation(value) {
            for (const gainNode of gainNodes) {
              gainNode.channelInterpretation = value;
            }

            channelInterpretation = value;
          },

          get context() {
            return scriptProcessorNode.context;
          },

          get inputs() {
            return gainNodes;
          },

          get numberOfInputs() {
            return options.numberOfInputs;
          },

          get numberOfOutputs() {
            return options.numberOfOutputs;
          },

          get onprocessorerror() {
            return onprocessorerror;
          },

          set onprocessorerror(value) {
            if (typeof onprocessorerror === 'function') {
              nativeAudioWorkletNodeFaker.removeEventListener('processorerror', onprocessorerror);
            }

            onprocessorerror = typeof value === 'function' ? value : null;

            if (typeof onprocessorerror === 'function') {
              nativeAudioWorkletNodeFaker.addEventListener('processorerror', onprocessorerror);
            }
          },

          get parameters() {
            return parameterMap;
          },

          get port() {
            return messageChannel.port2;
          },

          addEventListener(...args) {
            return scriptProcessorNode.addEventListener(args[0], args[1], args[2]);
          },

          connect: connectMultipleOutputs.bind(null, outputAudioNodes),
          disconnect: disconnectMultipleOutputs.bind(null, outputAudioNodes),

          dispatchEvent(...args) {
            return scriptProcessorNode.dispatchEvent(args[0]);
          },

          removeEventListener(...args) {
            return scriptProcessorNode.removeEventListener(args[0], args[1], args[2]);
          }

        };
        const patchedEventListeners = new Map();

        messageChannel.port1.addEventListener = (addEventListener => {
          return (...args) => {
            if (args[0] === 'message') {
              const unpatchedEventListener = typeof args[1] === 'function' ? args[1] : typeof args[1] === 'object' && args[1] !== null && typeof args[1].handleEvent === 'function' ? args[1].handleEvent : null;

              if (unpatchedEventListener !== null) {
                const patchedEventListener = patchedEventListeners.get(args[1]);

                if (patchedEventListener !== undefined) {
                  args[1] = patchedEventListener;
                } else {
                  args[1] = event => {
                    exposeCurrentFrameAndCurrentTime(nativeContext.currentTime, nativeContext.sampleRate, () => unpatchedEventListener(event));
                  };

                  patchedEventListeners.set(unpatchedEventListener, args[1]);
                }
              }
            }

            return addEventListener.call(messageChannel.port1, args[0], args[1], args[2]);
          };
        })(messageChannel.port1.addEventListener);

        messageChannel.port1.removeEventListener = (removeEventListener => {
          return (...args) => {
            if (args[0] === 'message') {
              const patchedEventListener = patchedEventListeners.get(args[1]);

              if (patchedEventListener !== undefined) {
                patchedEventListeners.delete(args[1]);
                args[1] = patchedEventListener;
              }
            }

            return removeEventListener.call(messageChannel.port1, args[0], args[1], args[2]);
          };
        })(messageChannel.port1.removeEventListener);

        let onmessage = null;
        Object.defineProperty(messageChannel.port1, 'onmessage', {
          get: () => onmessage,
          set: value => {
            if (typeof onmessage === 'function') {
              messageChannel.port1.removeEventListener('message', onmessage);
            }

            onmessage = typeof value === 'function' ? value : null;

            if (typeof onmessage === 'function') {
              messageChannel.port1.addEventListener('message', onmessage);
              messageChannel.port1.start();
            }
          }
        });
        processorConstructor.prototype.port = messageChannel.port1;
        let audioWorkletProcessor = null;
        const audioWorkletProcessorPromise = createAudioWorkletProcessor(nativeContext, nativeAudioWorkletNodeFaker, processorConstructor, options);
        audioWorkletProcessorPromise.then(dWrkltPrcssr => audioWorkletProcessor = dWrkltPrcssr);
        const inputs = createNestedArrays(options.numberOfInputs, options.channelCount);
        const outputs = createNestedArrays(options.numberOfOutputs, options.outputChannelCount);
        const parameters = processorConstructor.parameterDescriptors === undefined ? [] : processorConstructor.parameterDescriptors.reduce((prmtrs, {
          name
        }) => ({ ...prmtrs,
          [name]: new Float32Array(128)
        }), {});
        let isActive = true;

        const disconnectOutputsGraph = () => {
          if (options.numberOfOutputs > 0) {
            scriptProcessorNode.disconnect(outputChannelSplitterNode);
          }

          for (let i = 0, outputChannelSplitterNodeOutput = 0; i < options.numberOfOutputs; i += 1) {
            const outputChannelMergerNode = outputChannelMergerNodes[i];

            for (let j = 0; j < options.outputChannelCount[i]; j += 1) {
              outputChannelSplitterNode.disconnect(outputChannelMergerNode, outputChannelSplitterNodeOutput + j, j);
            }

            outputChannelSplitterNodeOutput += options.outputChannelCount[i];
          }
        }; // tslint:disable-next-line:deprecation


        scriptProcessorNode.onaudioprocess = ({
          inputBuffer,
          outputBuffer
        }) => {
          if (audioWorkletProcessor !== null) {
            for (let i = 0; i < bufferSize; i += 128) {
              for (let j = 0; j < options.numberOfInputs; j += 1) {
                for (let k = 0; k < options.channelCount; k += 1) {
                  copyFromChannel(inputBuffer, inputs[j], k, k, i);
                }
              }

              if (processorConstructor.parameterDescriptors !== undefined) {
                processorConstructor.parameterDescriptors.forEach(({
                  name
                }, index) => {
                  copyFromChannel(inputBuffer, parameters, name, numberOfInputChannels + index, i);
                });
              }

              for (let j = 0; j < options.numberOfInputs; j += 1) {
                for (let k = 0; k < options.outputChannelCount[j]; k += 1) {
                  // The byteLength will be 0 when the ArrayBuffer was transferred.
                  if (outputs[j][k].byteLength === 0) {
                    outputs[j][k] = new Float32Array(128);
                  }
                }
              }

              try {
                const potentiallyEmptyInputs = inputs.map((input, index) => {
                  const auxiliaryGainNodes = auxiliaryGainNodeStore.get(nativeAudioWorkletNodeFaker);

                  if (auxiliaryGainNodes === undefined || auxiliaryGainNodes.get(index) === undefined) {
                    return [];
                  }

                  return input;
                });
                const activeSourceFlag = exposeCurrentFrameAndCurrentTime(nativeContext.currentTime + i / nativeContext.sampleRate, nativeContext.sampleRate, () => audioWorkletProcessor.process(potentiallyEmptyInputs, outputs, parameters));
                isActive = activeSourceFlag;

                for (let j = 0, outputChannelSplitterNodeOutput = 0; j < options.numberOfOutputs; j += 1) {
                  for (let k = 0; k < options.outputChannelCount[j]; k += 1) {
                    copyToChannel(outputBuffer, outputs[j], k, outputChannelSplitterNodeOutput + k, i);
                  }

                  outputChannelSplitterNodeOutput += options.outputChannelCount[j];
                }
              } catch (error) {
                isActive = false;
                nativeAudioWorkletNodeFaker.dispatchEvent(new ErrorEvent('processorerror', {
                  error
                }));
              }

              if (!isActive) {
                for (let j = 0; j < options.numberOfInputs; j += 1) {
                  gainNodes[j].disconnect(inputChannelSplitterNodes[j]);

                  for (let k = 0; k < options.channelCount; k += 1) {
                    inputChannelSplitterNodes[i].disconnect(inputChannelMergerNode, k, j * options.channelCount + k);
                  }
                }

                if (processorConstructor.parameterDescriptors !== undefined) {
                  const length = processorConstructor.parameterDescriptors.length;

                  for (let j = 0; j < length; j += 1) {
                    const constantSourceNode = constantSourceNodes[j];
                    constantSourceNode.disconnect(inputChannelMergerNode, 0, numberOfInputChannels + j);
                    constantSourceNode.stop();
                  }
                }

                inputChannelMergerNode.disconnect(scriptProcessorNode);
                scriptProcessorNode.onaudioprocess = null; // tslint:disable-line:deprecation

                if (isConnected) {
                  disconnectOutputsGraph();
                } else {
                  disconnectFakeGraph();
                }

                break;
              }
            }
          }
        };

        let isConnected = false; // Bug #87: Only Firefox will fire an AudioProcessingEvent if there is no connected output.

        const nativeGainNode = createNativeGainNode(nativeContext, {
          channelCount: 1,
          channelCountMode: 'explicit',
          channelInterpretation: 'discrete',
          gain: 0
        });

        const connectFakeGraph = () => scriptProcessorNode.connect(nativeGainNode)
        /*
         * Bug #50: Edge does not yet allow to create AudioNodes on a closed AudioContext. Therefore the context property is used here
         * to make sure to connect the right destination.
         */
        .connect(nativeGainNode.context.destination);

        const disconnectFakeGraph = () => {
          scriptProcessorNode.disconnect(nativeGainNode);
          nativeGainNode.disconnect();
        };

        const whenConnected = () => {
          if (isActive) {
            disconnectFakeGraph();

            if (options.numberOfOutputs > 0) {
              scriptProcessorNode.connect(outputChannelSplitterNode);
            }

            for (let i = 0, outputChannelSplitterNodeOutput = 0; i < options.numberOfOutputs; i += 1) {
              const outputChannelMergerNode = outputChannelMergerNodes[i];

              for (let j = 0; j < options.outputChannelCount[i]; j += 1) {
                outputChannelSplitterNode.connect(outputChannelMergerNode, outputChannelSplitterNodeOutput + j, j);
              }

              outputChannelSplitterNodeOutput += options.outputChannelCount[i];
            }
          }

          isConnected = true;
        };

        const whenDisconnected = () => {
          if (isActive) {
            connectFakeGraph();
            disconnectOutputsGraph();
          }

          isConnected = false;
        };

        connectFakeGraph();
        return monitorConnections(nativeAudioWorkletNodeFaker, whenConnected, whenDisconnected);
      };
    };

    const createNativeBiquadFilterNodeFactory = createNativeAudioNode => {
      return (nativeContext, options) => {
        const nativeBiquadFilterNode = createNativeAudioNode(nativeContext, ntvCntxt => ntvCntxt.createBiquadFilter());
        assignNativeAudioNodeOptions(nativeBiquadFilterNode, options);
        assignNativeAudioNodeAudioParamValue(nativeBiquadFilterNode, options, 'Q');
        assignNativeAudioNodeAudioParamValue(nativeBiquadFilterNode, options, 'detune');
        assignNativeAudioNodeAudioParamValue(nativeBiquadFilterNode, options, 'frequency');
        assignNativeAudioNodeAudioParamValue(nativeBiquadFilterNode, options, 'gain');
        assignNativeAudioNodeOption(nativeBiquadFilterNode, options, 'type');
        return nativeBiquadFilterNode;
      };
    };

    const createNativeChannelMergerNodeFactory = (createNativeAudioNode, wrapChannelMergerNode) => {
      return (nativeContext, options) => {
        const nativeChannelMergerNode = createNativeAudioNode(nativeContext, ntvCntxt => {
          return ntvCntxt.createChannelMerger(options.numberOfInputs);
        }); // Bug #15: Safari does not return the default properties.
        // Bug #16: Safari does not throw an error when setting a different channelCount or channelCountMode.

        if (nativeChannelMergerNode.channelCount !== 1 && nativeChannelMergerNode.channelCountMode !== 'explicit') {
          wrapChannelMergerNode(nativeContext, nativeChannelMergerNode);
        }

        assignNativeAudioNodeOptions(nativeChannelMergerNode, options);
        return nativeChannelMergerNode;
      };
    };

    const wrapChannelSplitterNode = channelSplitterNode => {
      const channelCount = channelSplitterNode.numberOfOutputs; // Bug #97: Safari does not throw an error when attempting to change the channelCount to something other than its initial value.

      Object.defineProperty(channelSplitterNode, 'channelCount', {
        get: () => channelCount,
        set: value => {
          if (value !== channelCount) {
            throw createInvalidStateError();
          }
        }
      });
      /*
       * Bug #30: Only Chrome, Firefox & Opera throw an error when attempting to change the channelCountMode to something other than
       * explicit.
       */

      Object.defineProperty(channelSplitterNode, 'channelCountMode', {
        get: () => 'explicit',
        set: value => {
          if (value !== 'explicit') {
            throw createInvalidStateError();
          }
        }
      });
      /*
       * Bug #32: Only Chrome, Firefox & Opera throws an error when attempting to change the channelInterpretation to something other than
       * discrete.
       */

      Object.defineProperty(channelSplitterNode, 'channelInterpretation', {
        get: () => 'discrete',
        set: value => {
          if (value !== 'discrete') {
            throw createInvalidStateError();
          }
        }
      });
    };

    const createNativeChannelSplitterNodeFactory = createNativeAudioNode => {
      return (nativeContext, options) => {
        const nativeChannelSplitterNode = createNativeAudioNode(nativeContext, ntvCntxt => {
          return ntvCntxt.createChannelSplitter(options.numberOfOutputs);
        }); // Bug #96: Safari does not have the correct channelCount.
        // Bug #29: Edge & Safari do not have the correct channelCountMode.
        // Bug #31: Edge & Safari do not have the correct channelInterpretation.

        assignNativeAudioNodeOptions(nativeChannelSplitterNode, options); // Bug #29, #30, #31, #32, #96 & #97: Only Chrome, Firefox & Opera partially support the spec yet.

        wrapChannelSplitterNode(nativeChannelSplitterNode);
        return nativeChannelSplitterNode;
      };
    };

    const createNativeConstantSourceNodeFactory = (addSilentConnection, cacheTestResult, createNativeAudioNode, createNativeConstantSourceNodeFaker, testAudioScheduledSourceNodeStartMethodNegativeParametersSupport, testAudioScheduledSourceNodeStopMethodNegativeParametersSupport) => {
      return (nativeContext, options) => {
        // Bug #62: Edge & Safari do not support ConstantSourceNodes.
        if (nativeContext.createConstantSource === undefined) {
          return createNativeConstantSourceNodeFaker(nativeContext, options);
        }

        const nativeConstantSourceNode = createNativeAudioNode(nativeContext, ntvCntxt => {
          return ntvCntxt.createConstantSource();
        });
        assignNativeAudioNodeOptions(nativeConstantSourceNode, options);
        assignNativeAudioNodeAudioParamValue(nativeConstantSourceNode, options, 'offset'); // Bug #44: Only Chrome, Firefox & Opera throw a RangeError yet.

        if (!cacheTestResult(testAudioScheduledSourceNodeStartMethodNegativeParametersSupport, () => testAudioScheduledSourceNodeStartMethodNegativeParametersSupport(nativeContext))) {
          wrapAudioScheduledSourceNodeStartMethodNegativeParameters(nativeConstantSourceNode);
        } // Bug #44: Only Firefox does not throw a RangeError yet.


        if (!cacheTestResult(testAudioScheduledSourceNodeStopMethodNegativeParametersSupport, () => testAudioScheduledSourceNodeStopMethodNegativeParametersSupport(nativeContext))) {
          wrapAudioScheduledSourceNodeStopMethodNegativeParameters(nativeConstantSourceNode);
        } // Bug #175: Safari will not fire an ended event if the ConstantSourceNode is unconnected.


        addSilentConnection(nativeContext, nativeConstantSourceNode);
        return nativeConstantSourceNode;
      };
    };

    const interceptConnections = (original, interceptor) => {
      original.connect = interceptor.connect.bind(interceptor);
      original.disconnect = interceptor.disconnect.bind(interceptor);
      return original;
    };

    const createNativeConstantSourceNodeFakerFactory = (addSilentConnection, createNativeAudioBufferSourceNode, createNativeGainNode, monitorConnections) => {
      return (nativeContext, {
        offset,
        ...audioNodeOptions
      }) => {
        const audioBuffer = nativeContext.createBuffer(1, 2, nativeContext.sampleRate);
        const audioBufferSourceNode = createNativeAudioBufferSourceNode(nativeContext, {
          buffer: null,
          channelCount: 2,
          channelCountMode: 'max',
          channelInterpretation: 'speakers',
          loop: false,
          loopEnd: 0,
          loopStart: 0,
          playbackRate: 1
        });
        const gainNode = createNativeGainNode(nativeContext, { ...audioNodeOptions,
          gain: offset
        }); // Bug #5: Safari does not support copyFromChannel() and copyToChannel().

        const channelData = audioBuffer.getChannelData(0); // Bug #95: Safari does not play or loop one sample buffers.

        channelData[0] = 1;
        channelData[1] = 1;
        audioBufferSourceNode.buffer = audioBuffer;
        audioBufferSourceNode.loop = true;
        const nativeConstantSourceNodeFaker = {
          get bufferSize() {
            return undefined;
          },

          get channelCount() {
            return gainNode.channelCount;
          },

          set channelCount(value) {
            gainNode.channelCount = value;
          },

          get channelCountMode() {
            return gainNode.channelCountMode;
          },

          set channelCountMode(value) {
            gainNode.channelCountMode = value;
          },

          get channelInterpretation() {
            return gainNode.channelInterpretation;
          },

          set channelInterpretation(value) {
            gainNode.channelInterpretation = value;
          },

          get context() {
            return gainNode.context;
          },

          get inputs() {
            return [];
          },

          get numberOfInputs() {
            return audioBufferSourceNode.numberOfInputs;
          },

          get numberOfOutputs() {
            return gainNode.numberOfOutputs;
          },

          get offset() {
            return gainNode.gain;
          },

          get onended() {
            return audioBufferSourceNode.onended;
          },

          set onended(value) {
            audioBufferSourceNode.onended = value;
          },

          addEventListener(...args) {
            return audioBufferSourceNode.addEventListener(args[0], args[1], args[2]);
          },

          dispatchEvent(...args) {
            return audioBufferSourceNode.dispatchEvent(args[0]);
          },

          removeEventListener(...args) {
            return audioBufferSourceNode.removeEventListener(args[0], args[1], args[2]);
          },

          start(when = 0) {
            audioBufferSourceNode.start.call(audioBufferSourceNode, when);
          },

          stop(when = 0) {
            audioBufferSourceNode.stop.call(audioBufferSourceNode, when);
          }

        };

        const whenConnected = () => audioBufferSourceNode.connect(gainNode);

        const whenDisconnected = () => audioBufferSourceNode.disconnect(gainNode); // Bug #175: Safari will not fire an ended event if the AudioBufferSourceNode is unconnected.


        addSilentConnection(nativeContext, audioBufferSourceNode);
        return monitorConnections(interceptConnections(nativeConstantSourceNodeFaker, gainNode), whenConnected, whenDisconnected);
      };
    };

    const createNativeConvolverNodeFactory = (createNativeAudioNode, createNativeConvolverNodeFaker, createNotSupportedError, overwriteAccessors) => {
      return (nativeContext, options) => {
        const nativeConvolverNode = createNativeAudioNode(nativeContext, ntvCntxt => ntvCntxt.createConvolver());

        try {
          // Bug #166: Opera does not allow yet to set the channelCount to 1.
          nativeConvolverNode.channelCount = 1;
        } catch (err) {
          return createNativeConvolverNodeFaker(nativeContext, options);
        }

        assignNativeAudioNodeOptions(nativeConvolverNode, options); // The normalize property needs to be set before setting the buffer.

        if (options.disableNormalization === nativeConvolverNode.normalize) {
          nativeConvolverNode.normalize = !options.disableNormalization;
        }

        assignNativeAudioNodeOption(nativeConvolverNode, options, 'buffer'); // Bug #113: Edge & Safari allow to set the channelCount to a value larger than 2.

        if (options.channelCount > 2) {
          throw createNotSupportedError();
        }

        overwriteAccessors(nativeConvolverNode, 'channelCount', get => () => get.call(nativeConvolverNode), set => value => {
          if (value > 2) {
            throw createNotSupportedError();
          }

          return set.call(nativeConvolverNode, value);
        }); // Bug #114: Edge & Safari allow to set the channelCountMode to 'max'.

        if (options.channelCountMode === 'max') {
          throw createNotSupportedError();
        }

        overwriteAccessors(nativeConvolverNode, 'channelCountMode', get => () => get.call(nativeConvolverNode), set => value => {
          if (value === 'max') {
            throw createNotSupportedError();
          }

          return set.call(nativeConvolverNode, value);
        });
        return nativeConvolverNode;
      };
    };

    const createNativeConvolverNodeFakerFactory = (createNativeAudioNode, createNativeGainNode, monitorConnections) => {
      return (nativeContext, {
        buffer,
        channelCount,
        channelCountMode,
        channelInterpretation,
        disableNormalization
      }) => {
        const convolverNode = createNativeAudioNode(nativeContext, ntvCntxt => ntvCntxt.createConvolver());
        assignNativeAudioNodeOptions(convolverNode, {
          // Bug #166: Opera does not allow yet to set the channelCount to 1.
          channelCount: Math.max(channelCount, 2),
          // Bug #167: Opera does not allow yet to set the channelCountMode to 'explicit'.
          channelCountMode: channelCountMode === 'max' ? channelCountMode : 'clamped-max',
          channelInterpretation
        });
        const gainNode = createNativeGainNode(nativeContext, {
          channelCount,
          channelCountMode,
          channelInterpretation,
          gain: 1
        });
        const nativeConvolverNodeFaker = {
          get buffer() {
            return convolverNode.buffer;
          },

          set buffer(value) {
            convolverNode.buffer = value;
          },

          get bufferSize() {
            return undefined;
          },

          get channelCount() {
            return gainNode.channelCount;
          },

          set channelCount(value) {
            // Bug #166: Opera does not allow yet to set the channelCount to 1.
            if (value > 2) {
              convolverNode.channelCount = value;
            }

            gainNode.channelCount = value;
          },

          get channelCountMode() {
            return gainNode.channelCountMode;
          },

          set channelCountMode(value) {
            // Bug #167: Opera does not allow yet to set the channelCountMode to 'explicit'.
            if (value === 'max') {
              convolverNode.channelCountMode = value;
            }

            gainNode.channelCountMode = value;
          },

          get channelInterpretation() {
            return convolverNode.channelInterpretation;
          },

          set channelInterpretation(value) {
            convolverNode.channelInterpretation = value;
            gainNode.channelInterpretation = value;
          },

          get context() {
            return convolverNode.context;
          },

          get inputs() {
            return [convolverNode];
          },

          get numberOfInputs() {
            return convolverNode.numberOfInputs;
          },

          get numberOfOutputs() {
            return convolverNode.numberOfOutputs;
          },

          get normalize() {
            return convolverNode.normalize;
          },

          set normalize(value) {
            convolverNode.normalize = value;
          },

          addEventListener(...args) {
            return convolverNode.addEventListener(args[0], args[1], args[2]);
          },

          dispatchEvent(...args) {
            return convolverNode.dispatchEvent(args[0]);
          },

          removeEventListener(...args) {
            return convolverNode.removeEventListener(args[0], args[1], args[2]);
          }

        }; // The normalize property needs to be set before setting the buffer.

        if (disableNormalization === nativeConvolverNodeFaker.normalize) {
          nativeConvolverNodeFaker.normalize = !disableNormalization;
        }

        if (buffer !== nativeConvolverNodeFaker.buffer) {
          nativeConvolverNodeFaker.buffer = buffer;
        }

        const whenConnected = () => convolverNode.connect(gainNode);

        const whenDisconnected = () => convolverNode.disconnect(gainNode);

        return monitorConnections(interceptConnections(nativeConvolverNodeFaker, gainNode), whenConnected, whenDisconnected);
      };
    };

    const createNativeDelayNodeFactory = createNativeAudioNode => {
      return (nativeContext, options) => {
        const nativeDelayNode = createNativeAudioNode(nativeContext, ntvCntxt => ntvCntxt.createDelay(options.maxDelayTime));
        assignNativeAudioNodeOptions(nativeDelayNode, options);
        assignNativeAudioNodeAudioParamValue(nativeDelayNode, options, 'delayTime');
        return nativeDelayNode;
      };
    };

    const createNativeDynamicsCompressorNodeFactory = (createNativeAudioNode, createNotSupportedError) => {
      return (nativeContext, options) => {
        const nativeDynamicsCompressorNode = createNativeAudioNode(nativeContext, ntvCntxt => ntvCntxt.createDynamicsCompressor());
        assignNativeAudioNodeOptions(nativeDynamicsCompressorNode, options); // Bug #108: Only Chrome, Firefox and Opera disallow a channelCount of three and above yet.

        if (options.channelCount > 2) {
          throw createNotSupportedError();
        } // Bug #109: Only Chrome, Firefox and Opera disallow a channelCountMode of 'max'.


        if (options.channelCountMode === 'max') {
          throw createNotSupportedError();
        }

        assignNativeAudioNodeAudioParamValue(nativeDynamicsCompressorNode, options, 'attack');
        assignNativeAudioNodeAudioParamValue(nativeDynamicsCompressorNode, options, 'knee');
        assignNativeAudioNodeAudioParamValue(nativeDynamicsCompressorNode, options, 'ratio');
        assignNativeAudioNodeAudioParamValue(nativeDynamicsCompressorNode, options, 'release');
        assignNativeAudioNodeAudioParamValue(nativeDynamicsCompressorNode, options, 'threshold');
        return nativeDynamicsCompressorNode;
      };
    };

    const createNativeGainNodeFactory = createNativeAudioNode => {
      return (nativeContext, options) => {
        const nativeGainNode = createNativeAudioNode(nativeContext, ntvCntxt => ntvCntxt.createGain());
        assignNativeAudioNodeOptions(nativeGainNode, options);
        assignNativeAudioNodeAudioParamValue(nativeGainNode, options, 'gain');
        return nativeGainNode;
      };
    };

    const createNativeIIRFilterNodeFactory = (createNativeAudioNode, createNativeIIRFilterNodeFaker) => {
      return (nativeContext, baseLatency, options) => {
        // Bug #9: Safari does not support IIRFilterNodes.
        if (nativeContext.createIIRFilter === undefined) {
          return createNativeIIRFilterNodeFaker(nativeContext, baseLatency, options);
        }

        const nativeIIRFilterNode = createNativeAudioNode(nativeContext, ntvCntxt => {
          return ntvCntxt.createIIRFilter(options.feedforward, options.feedback);
        });
        assignNativeAudioNodeOptions(nativeIIRFilterNode, options);
        return nativeIIRFilterNode;
      };
    };

    function divide(a, b) {
      const denominator = b[0] * b[0] + b[1] * b[1];
      return [(a[0] * b[0] + a[1] * b[1]) / denominator, (a[1] * b[0] - a[0] * b[1]) / denominator];
    }

    function multiply(a, b) {
      return [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
    }

    function evaluatePolynomial(coefficient, z) {
      let result = [0, 0];

      for (let i = coefficient.length - 1; i >= 0; i -= 1) {
        result = multiply(result, z);
        result[0] += coefficient[i];
      }

      return result;
    }

    const createNativeIIRFilterNodeFakerFactory = (createInvalidAccessError, createInvalidStateError, createNativeScriptProcessorNode, createNotSupportedError) => {
      return (nativeContext, baseLatency, {
        channelCount,
        channelCountMode,
        channelInterpretation,
        feedback,
        feedforward
      }) => {
        const bufferSize = computeBufferSize(baseLatency, nativeContext.sampleRate);
        const feedbackLength = feedback.length;
        const feedforwardLength = feedforward.length;
        const minLength = Math.min(feedbackLength, feedforwardLength);

        if (feedback.length === 0 || feedback.length > 20) {
          throw createNotSupportedError();
        }

        if (feedback[0] === 0) {
          throw createInvalidStateError();
        }

        if (feedforward.length === 0 || feedforward.length > 20) {
          throw createNotSupportedError();
        }

        if (feedforward[0] === 0) {
          throw createInvalidStateError();
        }

        if (feedback[0] !== 1) {
          for (let i = 0; i < feedforwardLength; i += 1) {
            feedforward[i] /= feedback[0];
          }

          for (let i = 1; i < feedbackLength; i += 1) {
            feedback[i] /= feedback[0];
          }
        }

        const scriptProcessorNode = createNativeScriptProcessorNode(nativeContext, bufferSize, channelCount, channelCount);
        scriptProcessorNode.channelCount = channelCount;
        scriptProcessorNode.channelCountMode = channelCountMode;
        scriptProcessorNode.channelInterpretation = channelInterpretation;
        const bufferLength = 32;
        const bufferIndexes = [];
        const xBuffers = [];
        const yBuffers = [];

        for (let i = 0; i < channelCount; i += 1) {
          bufferIndexes.push(0);
          const xBuffer = new Float32Array(bufferLength);
          const yBuffer = new Float32Array(bufferLength);
          xBuffer.fill(0);
          yBuffer.fill(0);
          xBuffers.push(xBuffer);
          yBuffers.push(yBuffer);
        } // tslint:disable-next-line:deprecation


        scriptProcessorNode.onaudioprocess = event => {
          const inputBuffer = event.inputBuffer;
          const outputBuffer = event.outputBuffer;
          const numberOfChannels = inputBuffer.numberOfChannels;

          for (let i = 0; i < numberOfChannels; i += 1) {
            const input = inputBuffer.getChannelData(i);
            const output = outputBuffer.getChannelData(i);
            bufferIndexes[i] = filterBuffer(feedback, feedbackLength, feedforward, feedforwardLength, minLength, xBuffers[i], yBuffers[i], bufferIndexes[i], bufferLength, input, output);
          }
        };

        const nyquist = nativeContext.sampleRate / 2;
        const nativeIIRFilterNodeFaker = {
          get bufferSize() {
            return bufferSize;
          },

          get channelCount() {
            return scriptProcessorNode.channelCount;
          },

          set channelCount(value) {
            scriptProcessorNode.channelCount = value;
          },

          get channelCountMode() {
            return scriptProcessorNode.channelCountMode;
          },

          set channelCountMode(value) {
            scriptProcessorNode.channelCountMode = value;
          },

          get channelInterpretation() {
            return scriptProcessorNode.channelInterpretation;
          },

          set channelInterpretation(value) {
            scriptProcessorNode.channelInterpretation = value;
          },

          get context() {
            return scriptProcessorNode.context;
          },

          get inputs() {
            return [scriptProcessorNode];
          },

          get numberOfInputs() {
            return scriptProcessorNode.numberOfInputs;
          },

          get numberOfOutputs() {
            return scriptProcessorNode.numberOfOutputs;
          },

          addEventListener(...args) {
            // @todo Dissallow adding an audioprocess listener.
            return scriptProcessorNode.addEventListener(args[0], args[1], args[2]);
          },

          dispatchEvent(...args) {
            return scriptProcessorNode.dispatchEvent(args[0]);
          },

          getFrequencyResponse(frequencyHz, magResponse, phaseResponse) {
            if (frequencyHz.length !== magResponse.length || magResponse.length !== phaseResponse.length) {
              throw createInvalidAccessError();
            }

            const length = frequencyHz.length;

            for (let i = 0; i < length; i += 1) {
              const omega = -Math.PI * (frequencyHz[i] / nyquist);
              const z = [Math.cos(omega), Math.sin(omega)];
              const numerator = evaluatePolynomial(feedforward, z);
              const denominator = evaluatePolynomial(feedback, z);
              const response = divide(numerator, denominator);
              magResponse[i] = Math.sqrt(response[0] * response[0] + response[1] * response[1]);
              phaseResponse[i] = Math.atan2(response[1], response[0]);
            }
          },

          removeEventListener(...args) {
            return scriptProcessorNode.removeEventListener(args[0], args[1], args[2]);
          }

        };
        return interceptConnections(nativeIIRFilterNodeFaker, scriptProcessorNode);
      };
    };

    const createNativeMediaElementAudioSourceNodeFactory = createNativeAudioNode => {
      return (nativeAudioContext, options) => createNativeAudioNode(nativeAudioContext, ntvDCntxt => {
        return ntvDCntxt.createMediaElementSource(options.mediaElement);
      });
    };

    const createNativeMediaStreamAudioDestinationNodeFactory = (createNativeAudioNode, createNotSupportedError) => {
      return (nativeAudioContext, options) => {
        // Bug #64: Edge does not support MediaStreamAudioDestinationNodes.
        if (nativeAudioContext.createMediaStreamDestination === undefined) {
          throw createNotSupportedError();
        }

        const nativeMediaStreamAudioDestinationNode = createNativeAudioNode(nativeAudioContext, ntvDCntxt => {
          return ntvDCntxt.createMediaStreamDestination();
        });
        assignNativeAudioNodeOptions(nativeMediaStreamAudioDestinationNode, options); // Bug #174: Safari does expose a wrong numberOfOutputs.

        if (nativeMediaStreamAudioDestinationNode.numberOfOutputs === 1) {
          Object.defineProperty(nativeMediaStreamAudioDestinationNode, 'numberOfOutputs', {
            get: () => 0
          });
        }

        return nativeMediaStreamAudioDestinationNode;
      };
    };

    const createNativeMediaStreamAudioSourceNodeFactory = createNativeAudioNode => {
      return (nativeAudioContext, {
        mediaStream
      }) => {
        const audioStreamTracks = mediaStream.getAudioTracks();
        const nativeMediaStreamAudioSourceNode = createNativeAudioNode(nativeAudioContext, ntvDCntxt => {
          /*
           * Bug #151: Safari does not use the audio track as input anymore if it gets removed from the mediaStream after construction.
           * Bug #159: Safari picks the first audio track if the MediaStream has more than one audio track.
           */
          audioStreamTracks.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
          const filteredAudioStreamTracks = audioStreamTracks.slice(0, 1);
          return ntvDCntxt.createMediaStreamSource(new MediaStream(filteredAudioStreamTracks));
        }); // Bug #63: Edge does not expose the mediaStream yet.

        Object.defineProperty(nativeMediaStreamAudioSourceNode, 'mediaStream', {
          value: mediaStream
        });
        return nativeMediaStreamAudioSourceNode;
      };
    };

    const createNativeMediaStreamTrackAudioSourceNodeFactory = (createInvalidStateError, createNativeAudioNode, isNativeOfflineAudioContext) => {
      return (nativeAudioContext, {
        mediaStreamTrack
      }) => {
        if (typeof nativeAudioContext.createMediaStreamTrackSource === 'function') {
          return createNativeAudioNode(nativeAudioContext, ntvDCntxt => ntvDCntxt.createMediaStreamTrackSource(mediaStreamTrack));
        } // Bug #121: Only Firefox does yet support the MediaStreamTrackAudioSourceNode.


        return createNativeAudioNode(nativeAudioContext, ntvDCntxt => {
          const mediaStream = new MediaStream([mediaStreamTrack]);
          const nativeMediaStreamAudioSourceNode = ntvDCntxt.createMediaStreamSource(mediaStream); // Bug #120: Firefox does not throw an error if the mediaStream has no audio track.

          if (mediaStreamTrack.kind !== 'audio') {
            throw createInvalidStateError();
          } // Bug #172: Safari allows to create a MediaStreamAudioSourceNode with an OfflineAudioContext.


          if (isNativeOfflineAudioContext(ntvDCntxt)) {
            throw new TypeError();
          }

          return nativeMediaStreamAudioSourceNode;
        });
      };
    };

    const createNativeOfflineAudioContextConstructor = window => {
      if (window === null) {
        return null;
      }

      if (window.hasOwnProperty('OfflineAudioContext')) {
        return window.OfflineAudioContext;
      }

      return window.hasOwnProperty('webkitOfflineAudioContext') ? window.webkitOfflineAudioContext : null;
    };

    const createNativeOscillatorNodeFactory = (addSilentConnection, cacheTestResult, createNativeAudioNode, testAudioScheduledSourceNodeStartMethodNegativeParametersSupport, testAudioScheduledSourceNodeStopMethodConsecutiveCallsSupport, testAudioScheduledSourceNodeStopMethodNegativeParametersSupport, wrapAudioScheduledSourceNodeStopMethodConsecutiveCalls) => {
      return (nativeContext, options) => {
        const nativeOscillatorNode = createNativeAudioNode(nativeContext, ntvCntxt => ntvCntxt.createOscillator());
        assignNativeAudioNodeOptions(nativeOscillatorNode, options);
        assignNativeAudioNodeAudioParamValue(nativeOscillatorNode, options, 'detune');
        assignNativeAudioNodeAudioParamValue(nativeOscillatorNode, options, 'frequency');

        if (options.periodicWave !== undefined) {
          nativeOscillatorNode.setPeriodicWave(options.periodicWave);
        } else {
          assignNativeAudioNodeOption(nativeOscillatorNode, options, 'type');
        } // Bug #44: Only Chrome & Opera throw a RangeError yet.


        if (!cacheTestResult(testAudioScheduledSourceNodeStartMethodNegativeParametersSupport, () => testAudioScheduledSourceNodeStartMethodNegativeParametersSupport(nativeContext))) {
          wrapAudioScheduledSourceNodeStartMethodNegativeParameters(nativeOscillatorNode);
        } // Bug #19: Safari does not ignore calls to stop() of an already stopped AudioBufferSourceNode.


        if (!cacheTestResult(testAudioScheduledSourceNodeStopMethodConsecutiveCallsSupport, () => testAudioScheduledSourceNodeStopMethodConsecutiveCallsSupport(nativeContext))) {
          wrapAudioScheduledSourceNodeStopMethodConsecutiveCalls(nativeOscillatorNode, nativeContext);
        } // Bug #44: Only Firefox does not throw a RangeError yet.


        if (!cacheTestResult(testAudioScheduledSourceNodeStopMethodNegativeParametersSupport, () => testAudioScheduledSourceNodeStopMethodNegativeParametersSupport(nativeContext))) {
          wrapAudioScheduledSourceNodeStopMethodNegativeParameters(nativeOscillatorNode);
        } // Bug #175: Safari will not fire an ended event if the OscillatorNode is unconnected.


        addSilentConnection(nativeContext, nativeOscillatorNode);
        return nativeOscillatorNode;
      };
    };

    const createNativePannerNodeFactory = (createNativeAudioNode, createNativePannerNodeFaker) => {
      return (nativeContext, options) => {
        const nativePannerNode = createNativeAudioNode(nativeContext, ntvCntxt => ntvCntxt.createPanner()); // Bug #124: Edge & Safari do not support modifying the orientation and the position with AudioParams.

        if (nativePannerNode.orientationX === undefined) {
          return createNativePannerNodeFaker(nativeContext, options);
        }

        assignNativeAudioNodeOptions(nativePannerNode, options);
        assignNativeAudioNodeAudioParamValue(nativePannerNode, options, 'orientationX');
        assignNativeAudioNodeAudioParamValue(nativePannerNode, options, 'orientationY');
        assignNativeAudioNodeAudioParamValue(nativePannerNode, options, 'orientationZ');
        assignNativeAudioNodeAudioParamValue(nativePannerNode, options, 'positionX');
        assignNativeAudioNodeAudioParamValue(nativePannerNode, options, 'positionY');
        assignNativeAudioNodeAudioParamValue(nativePannerNode, options, 'positionZ');
        assignNativeAudioNodeOption(nativePannerNode, options, 'coneInnerAngle');
        assignNativeAudioNodeOption(nativePannerNode, options, 'coneOuterAngle');
        assignNativeAudioNodeOption(nativePannerNode, options, 'coneOuterGain');
        assignNativeAudioNodeOption(nativePannerNode, options, 'distanceModel');
        assignNativeAudioNodeOption(nativePannerNode, options, 'maxDistance');
        assignNativeAudioNodeOption(nativePannerNode, options, 'panningModel');
        assignNativeAudioNodeOption(nativePannerNode, options, 'refDistance');
        assignNativeAudioNodeOption(nativePannerNode, options, 'rolloffFactor');
        return nativePannerNode;
      };
    };

    const createNativePannerNodeFakerFactory = (connectNativeAudioNodeToNativeAudioNode, createInvalidStateError, createNativeAudioNode, createNativeChannelMergerNode, createNativeGainNode, createNativeScriptProcessorNode, createNativeWaveShaperNode, createNotSupportedError, disconnectNativeAudioNodeFromNativeAudioNode, monitorConnections) => {
      return (nativeContext, {
        coneInnerAngle,
        coneOuterAngle,
        coneOuterGain,
        distanceModel,
        maxDistance,
        orientationX,
        orientationY,
        orientationZ,
        panningModel,
        positionX,
        positionY,
        positionZ,
        refDistance,
        rolloffFactor,
        ...audioNodeOptions
      }) => {
        const pannerNode = createNativeAudioNode(nativeContext, ntvCntxt => ntvCntxt.createPanner()); // Bug #125: Safari does not throw an error yet.

        if (audioNodeOptions.channelCount > 2) {
          throw createNotSupportedError();
        } // Bug #126: Safari does not throw an error yet.


        if (audioNodeOptions.channelCountMode === 'max') {
          throw createNotSupportedError();
        }

        assignNativeAudioNodeOptions(pannerNode, audioNodeOptions);
        const SINGLE_CHANNEL_OPTIONS = {
          channelCount: 1,
          channelCountMode: 'explicit',
          channelInterpretation: 'discrete'
        };
        const channelMergerNode = createNativeChannelMergerNode(nativeContext, { ...SINGLE_CHANNEL_OPTIONS,
          channelInterpretation: 'speakers',
          numberOfInputs: 6
        });
        const inputGainNode = createNativeGainNode(nativeContext, { ...audioNodeOptions,
          gain: 1
        });
        const orientationXGainNode = createNativeGainNode(nativeContext, { ...SINGLE_CHANNEL_OPTIONS,
          gain: 1
        });
        const orientationYGainNode = createNativeGainNode(nativeContext, { ...SINGLE_CHANNEL_OPTIONS,
          gain: 0
        });
        const orientationZGainNode = createNativeGainNode(nativeContext, { ...SINGLE_CHANNEL_OPTIONS,
          gain: 0
        });
        const positionXGainNode = createNativeGainNode(nativeContext, { ...SINGLE_CHANNEL_OPTIONS,
          gain: 0
        });
        const positionYGainNode = createNativeGainNode(nativeContext, { ...SINGLE_CHANNEL_OPTIONS,
          gain: 0
        });
        const positionZGainNode = createNativeGainNode(nativeContext, { ...SINGLE_CHANNEL_OPTIONS,
          gain: 0
        });
        const scriptProcessorNode = createNativeScriptProcessorNode(nativeContext, 256, 6, 1);
        const waveShaperNode = createNativeWaveShaperNode(nativeContext, { ...SINGLE_CHANNEL_OPTIONS,
          curve: new Float32Array([1, 1]),
          oversample: 'none'
        });
        let lastOrientation = [orientationX, orientationY, orientationZ];
        let lastPosition = [positionX, positionY, positionZ]; // tslint:disable-next-line:deprecation

        scriptProcessorNode.onaudioprocess = ({
          inputBuffer
        }) => {
          const orientation = [inputBuffer.getChannelData(0)[0], inputBuffer.getChannelData(1)[0], inputBuffer.getChannelData(2)[0]];

          if (orientation.some((value, index) => value !== lastOrientation[index])) {
            pannerNode.setOrientation(...orientation); // tslint:disable-line:deprecation

            lastOrientation = orientation;
          }

          const positon = [inputBuffer.getChannelData(3)[0], inputBuffer.getChannelData(4)[0], inputBuffer.getChannelData(5)[0]];

          if (positon.some((value, index) => value !== lastPosition[index])) {
            pannerNode.setPosition(...positon); // tslint:disable-line:deprecation

            lastPosition = positon;
          }
        };

        Object.defineProperty(orientationYGainNode.gain, 'defaultValue', {
          get: () => 0
        });
        Object.defineProperty(orientationZGainNode.gain, 'defaultValue', {
          get: () => 0
        });
        Object.defineProperty(positionXGainNode.gain, 'defaultValue', {
          get: () => 0
        });
        Object.defineProperty(positionYGainNode.gain, 'defaultValue', {
          get: () => 0
        });
        Object.defineProperty(positionZGainNode.gain, 'defaultValue', {
          get: () => 0
        });
        const nativePannerNodeFaker = {
          get bufferSize() {
            return undefined;
          },

          get channelCount() {
            return pannerNode.channelCount;
          },

          set channelCount(value) {
            // Bug #125: Safari does not throw an error yet.
            if (value > 2) {
              throw createNotSupportedError();
            }

            inputGainNode.channelCount = value;
            pannerNode.channelCount = value;
          },

          get channelCountMode() {
            return pannerNode.channelCountMode;
          },

          set channelCountMode(value) {
            // Bug #126: Safari does not throw an error yet.
            if (value === 'max') {
              throw createNotSupportedError();
            }

            inputGainNode.channelCountMode = value;
            pannerNode.channelCountMode = value;
          },

          get channelInterpretation() {
            return pannerNode.channelInterpretation;
          },

          set channelInterpretation(value) {
            inputGainNode.channelInterpretation = value;
            pannerNode.channelInterpretation = value;
          },

          get coneInnerAngle() {
            return pannerNode.coneInnerAngle;
          },

          set coneInnerAngle(value) {
            pannerNode.coneInnerAngle = value;
          },

          get coneOuterAngle() {
            return pannerNode.coneOuterAngle;
          },

          set coneOuterAngle(value) {
            pannerNode.coneOuterAngle = value;
          },

          get coneOuterGain() {
            return pannerNode.coneOuterGain;
          },

          set coneOuterGain(value) {
            // Bug #127: Edge & Safari do not throw an InvalidStateError yet.
            if (value < 0 || value > 1) {
              throw createInvalidStateError();
            }

            pannerNode.coneOuterGain = value;
          },

          get context() {
            return pannerNode.context;
          },

          get distanceModel() {
            return pannerNode.distanceModel;
          },

          set distanceModel(value) {
            pannerNode.distanceModel = value;
          },

          get inputs() {
            return [inputGainNode];
          },

          get maxDistance() {
            return pannerNode.maxDistance;
          },

          set maxDistance(value) {
            // Bug #128: Edge & Safari do not throw an error yet.
            if (value < 0) {
              throw new RangeError();
            }

            pannerNode.maxDistance = value;
          },

          get numberOfInputs() {
            return pannerNode.numberOfInputs;
          },

          get numberOfOutputs() {
            return pannerNode.numberOfOutputs;
          },

          get orientationX() {
            return orientationXGainNode.gain;
          },

          get orientationY() {
            return orientationYGainNode.gain;
          },

          get orientationZ() {
            return orientationZGainNode.gain;
          },

          get panningModel() {
            return pannerNode.panningModel;
          },

          set panningModel(value) {
            pannerNode.panningModel = value; // Bug #123: Edge does not support HRTF as panningModel.

            if (pannerNode.panningModel !== value && value === 'HRTF') {
              throw createNotSupportedError();
            }
          },

          get positionX() {
            return positionXGainNode.gain;
          },

          get positionY() {
            return positionYGainNode.gain;
          },

          get positionZ() {
            return positionZGainNode.gain;
          },

          get refDistance() {
            return pannerNode.refDistance;
          },

          set refDistance(value) {
            // Bug #129: Edge & Safari do not throw an error yet.
            if (value < 0) {
              throw new RangeError();
            }

            pannerNode.refDistance = value;
          },

          get rolloffFactor() {
            return pannerNode.rolloffFactor;
          },

          set rolloffFactor(value) {
            // Bug #130: Edge & Safari do not throw an error yet.
            if (value < 0) {
              throw new RangeError();
            }

            pannerNode.rolloffFactor = value;
          },

          addEventListener(...args) {
            return inputGainNode.addEventListener(args[0], args[1], args[2]);
          },

          dispatchEvent(...args) {
            return inputGainNode.dispatchEvent(args[0]);
          },

          removeEventListener(...args) {
            return inputGainNode.removeEventListener(args[0], args[1], args[2]);
          }

        };

        if (coneInnerAngle !== nativePannerNodeFaker.coneInnerAngle) {
          nativePannerNodeFaker.coneInnerAngle = coneInnerAngle;
        }

        if (coneOuterAngle !== nativePannerNodeFaker.coneOuterAngle) {
          nativePannerNodeFaker.coneOuterAngle = coneOuterAngle;
        }

        if (coneOuterGain !== nativePannerNodeFaker.coneOuterGain) {
          nativePannerNodeFaker.coneOuterGain = coneOuterGain;
        }

        if (distanceModel !== nativePannerNodeFaker.distanceModel) {
          nativePannerNodeFaker.distanceModel = distanceModel;
        }

        if (maxDistance !== nativePannerNodeFaker.maxDistance) {
          nativePannerNodeFaker.maxDistance = maxDistance;
        }

        if (orientationX !== nativePannerNodeFaker.orientationX.value) {
          nativePannerNodeFaker.orientationX.value = orientationX;
        }

        if (orientationY !== nativePannerNodeFaker.orientationY.value) {
          nativePannerNodeFaker.orientationY.value = orientationY;
        }

        if (orientationZ !== nativePannerNodeFaker.orientationZ.value) {
          nativePannerNodeFaker.orientationZ.value = orientationZ;
        }

        if (panningModel !== nativePannerNodeFaker.panningModel) {
          nativePannerNodeFaker.panningModel = panningModel;
        }

        if (positionX !== nativePannerNodeFaker.positionX.value) {
          nativePannerNodeFaker.positionX.value = positionX;
        }

        if (positionY !== nativePannerNodeFaker.positionY.value) {
          nativePannerNodeFaker.positionY.value = positionY;
        }

        if (positionZ !== nativePannerNodeFaker.positionZ.value) {
          nativePannerNodeFaker.positionZ.value = positionZ;
        }

        if (refDistance !== nativePannerNodeFaker.refDistance) {
          nativePannerNodeFaker.refDistance = refDistance;
        }

        if (rolloffFactor !== nativePannerNodeFaker.rolloffFactor) {
          nativePannerNodeFaker.rolloffFactor = rolloffFactor;
        }

        if (lastOrientation[0] !== 1 || lastOrientation[1] !== 0 || lastOrientation[2] !== 0) {
          pannerNode.setOrientation(...lastOrientation); // tslint:disable-line:deprecation
        }

        if (lastPosition[0] !== 0 || lastPosition[1] !== 0 || lastPosition[2] !== 0) {
          pannerNode.setPosition(...lastPosition); // tslint:disable-line:deprecation
        }

        const whenConnected = () => {
          inputGainNode.connect(pannerNode); // Bug #119: Safari does not fully support the WaveShaperNode.

          connectNativeAudioNodeToNativeAudioNode(inputGainNode, waveShaperNode, 0, 0);
          waveShaperNode.connect(orientationXGainNode).connect(channelMergerNode, 0, 0);
          waveShaperNode.connect(orientationYGainNode).connect(channelMergerNode, 0, 1);
          waveShaperNode.connect(orientationZGainNode).connect(channelMergerNode, 0, 2);
          waveShaperNode.connect(positionXGainNode).connect(channelMergerNode, 0, 3);
          waveShaperNode.connect(positionYGainNode).connect(channelMergerNode, 0, 4);
          waveShaperNode.connect(positionZGainNode).connect(channelMergerNode, 0, 5);
          channelMergerNode.connect(scriptProcessorNode).connect(nativeContext.destination);
        };

        const whenDisconnected = () => {
          inputGainNode.disconnect(pannerNode); // Bug #119: Safari does not fully support the WaveShaperNode.

          disconnectNativeAudioNodeFromNativeAudioNode(inputGainNode, waveShaperNode, 0, 0);
          waveShaperNode.disconnect(orientationXGainNode);
          orientationXGainNode.disconnect(channelMergerNode);
          waveShaperNode.disconnect(orientationYGainNode);
          orientationYGainNode.disconnect(channelMergerNode);
          waveShaperNode.disconnect(orientationZGainNode);
          orientationZGainNode.disconnect(channelMergerNode);
          waveShaperNode.disconnect(positionXGainNode);
          positionXGainNode.disconnect(channelMergerNode);
          waveShaperNode.disconnect(positionYGainNode);
          positionYGainNode.disconnect(channelMergerNode);
          waveShaperNode.disconnect(positionZGainNode);
          positionZGainNode.disconnect(channelMergerNode);
          channelMergerNode.disconnect(scriptProcessorNode);
          scriptProcessorNode.disconnect(nativeContext.destination);
        };

        return monitorConnections(interceptConnections(nativePannerNodeFaker, pannerNode), whenConnected, whenDisconnected);
      };
    };

    const createNativePeriodicWaveFactory = getBackupNativeContext => {
      return (nativeContext, {
        disableNormalization,
        imag,
        real
      }) => {
        // Bug #50: Only Edge does currently not allow to create AudioNodes (and other objects) on a closed context yet.
        const backupNativeContext = getBackupNativeContext(nativeContext); // @todo Edge, Firefox & Safari do only accept Float32Arrays.

        const wrappedImag = new Float32Array(imag);
        const wrappedReal = new Float32Array(real);

        if (backupNativeContext !== null) {
          return backupNativeContext.createPeriodicWave(wrappedReal, wrappedImag, {
            disableNormalization
          });
        }

        return nativeContext.createPeriodicWave(wrappedReal, wrappedImag, {
          disableNormalization
        });
      };
    };

    const createNativeScriptProcessorNodeFactory = createNativeAudioNode => {
      return (nativeContext, bufferSize, numberOfInputChannels, numberOfOutputChannels) => {
        return createNativeAudioNode(nativeContext, ntvCntxt => {
          return ntvCntxt.createScriptProcessor(bufferSize, numberOfInputChannels, numberOfOutputChannels);
        });
      };
    };

    const createNativeStereoPannerNodeFactory = (createNativeAudioNode, createNativeStereoPannerNodeFaker, createNotSupportedError) => {
      return (nativeContext, options) => createNativeAudioNode(nativeContext, ntvCntxt => {
        const channelCountMode = options.channelCountMode;
        /*
         * Bug #105: The channelCountMode of 'clamped-max' should be supported. However it is not possible to write a polyfill for Safari
         * which supports it and therefore it can't be supported at all.
         */

        if (channelCountMode === 'clamped-max') {
          throw createNotSupportedError();
        } // Bug #105: Safari does not support the StereoPannerNode.


        if (nativeContext.createStereoPanner === undefined) {
          return createNativeStereoPannerNodeFaker(nativeContext, options);
        }

        const nativeStereoPannerNode = ntvCntxt.createStereoPanner();
        assignNativeAudioNodeOptions(nativeStereoPannerNode, options);
        assignNativeAudioNodeAudioParamValue(nativeStereoPannerNode, options, 'pan');
        /*
         * Bug #105: The channelCountMode of 'clamped-max' should be supported. However it is not possible to write a polyfill for Safari
         * which supports it and therefore it can't be supported at all.
         */

        Object.defineProperty(nativeStereoPannerNode, 'channelCountMode', {
          get: () => channelCountMode,
          set: value => {
            if (value !== channelCountMode) {
              throw createNotSupportedError();
            }
          }
        });
        return nativeStereoPannerNode;
      });
    };

    const createNativeStereoPannerNodeFakerFactory = (createNativeChannelMergerNode, createNativeChannelSplitterNode, createNativeGainNode, createNativeWaveShaperNode, createNotSupportedError, monitorConnections) => {
      // The curve has a size of 14bit plus 1 value to have an exact representation for zero. This value has been determined experimentally.
      const CURVE_SIZE = 16385;
      const DC_CURVE = new Float32Array([1, 1]);
      const HALF_PI = Math.PI / 2;
      const SINGLE_CHANNEL_OPTIONS = {
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'discrete'
      };
      const SINGLE_CHANNEL_WAVE_SHAPER_OPTIONS = { ...SINGLE_CHANNEL_OPTIONS,
        oversample: 'none'
      };

      const buildInternalGraphForMono = (nativeContext, inputGainNode, panGainNode, channelMergerNode) => {
        const leftWaveShaperCurve = new Float32Array(CURVE_SIZE);
        const rightWaveShaperCurve = new Float32Array(CURVE_SIZE);

        for (let i = 0; i < CURVE_SIZE; i += 1) {
          const x = i / (CURVE_SIZE - 1) * HALF_PI;
          leftWaveShaperCurve[i] = Math.cos(x);
          rightWaveShaperCurve[i] = Math.sin(x);
        }

        const leftGainNode = createNativeGainNode(nativeContext, { ...SINGLE_CHANNEL_OPTIONS,
          gain: 0
        }); // Bug #119: Safari does not fully support the WaveShaperNode.

        const leftWaveShaperNode = createNativeWaveShaperNode(nativeContext, { ...SINGLE_CHANNEL_WAVE_SHAPER_OPTIONS,
          curve: leftWaveShaperCurve
        }); // Bug #119: Safari does not fully support the WaveShaperNode.

        const panWaveShaperNode = createNativeWaveShaperNode(nativeContext, { ...SINGLE_CHANNEL_WAVE_SHAPER_OPTIONS,
          curve: DC_CURVE
        });
        const rightGainNode = createNativeGainNode(nativeContext, { ...SINGLE_CHANNEL_OPTIONS,
          gain: 0
        }); // Bug #119: Safari does not fully support the WaveShaperNode.

        const rightWaveShaperNode = createNativeWaveShaperNode(nativeContext, { ...SINGLE_CHANNEL_WAVE_SHAPER_OPTIONS,
          curve: rightWaveShaperCurve
        });
        return {
          connectGraph() {
            inputGainNode.connect(leftGainNode);
            inputGainNode.connect(panWaveShaperNode.inputs[0]);
            inputGainNode.connect(rightGainNode);
            panWaveShaperNode.connect(panGainNode);
            panGainNode.connect(leftWaveShaperNode.inputs[0]);
            panGainNode.connect(rightWaveShaperNode.inputs[0]);
            leftWaveShaperNode.connect(leftGainNode.gain);
            rightWaveShaperNode.connect(rightGainNode.gain);
            leftGainNode.connect(channelMergerNode, 0, 0);
            rightGainNode.connect(channelMergerNode, 0, 1);
          },

          disconnectGraph() {
            inputGainNode.disconnect(leftGainNode);
            inputGainNode.disconnect(panWaveShaperNode.inputs[0]);
            inputGainNode.disconnect(rightGainNode);
            panWaveShaperNode.disconnect(panGainNode);
            panGainNode.disconnect(leftWaveShaperNode.inputs[0]);
            panGainNode.disconnect(rightWaveShaperNode.inputs[0]);
            leftWaveShaperNode.disconnect(leftGainNode.gain);
            rightWaveShaperNode.disconnect(rightGainNode.gain);
            leftGainNode.disconnect(channelMergerNode, 0, 0);
            rightGainNode.disconnect(channelMergerNode, 0, 1);
          }

        };
      };

      const buildInternalGraphForStereo = (nativeContext, inputGainNode, panGainNode, channelMergerNode) => {
        const leftInputForLeftOutputWaveShaperCurve = new Float32Array(CURVE_SIZE);
        const leftInputForRightOutputWaveShaperCurve = new Float32Array(CURVE_SIZE);
        const rightInputForLeftOutputWaveShaperCurve = new Float32Array(CURVE_SIZE);
        const rightInputForRightOutputWaveShaperCurve = new Float32Array(CURVE_SIZE);
        const centerIndex = Math.floor(CURVE_SIZE / 2);

        for (let i = 0; i < CURVE_SIZE; i += 1) {
          if (i > centerIndex) {
            const x = (i - centerIndex) / (CURVE_SIZE - 1 - centerIndex) * HALF_PI;
            leftInputForLeftOutputWaveShaperCurve[i] = Math.cos(x);
            leftInputForRightOutputWaveShaperCurve[i] = Math.sin(x);
            rightInputForLeftOutputWaveShaperCurve[i] = 0;
            rightInputForRightOutputWaveShaperCurve[i] = 1;
          } else {
            const x = i / (CURVE_SIZE - 1 - centerIndex) * HALF_PI;
            leftInputForLeftOutputWaveShaperCurve[i] = 1;
            leftInputForRightOutputWaveShaperCurve[i] = 0;
            rightInputForLeftOutputWaveShaperCurve[i] = Math.cos(x);
            rightInputForRightOutputWaveShaperCurve[i] = Math.sin(x);
          }
        }

        const channelSplitterNode = createNativeChannelSplitterNode(nativeContext, {
          channelCount: 2,
          channelCountMode: 'explicit',
          channelInterpretation: 'discrete',
          numberOfOutputs: 2
        });
        const leftInputForLeftOutputGainNode = createNativeGainNode(nativeContext, { ...SINGLE_CHANNEL_OPTIONS,
          gain: 0
        }); // Bug #119: Safari does not fully support the WaveShaperNode.

        const leftInputForLeftOutputWaveShaperNode = createNativeWaveShaperNode(nativeContext, { ...SINGLE_CHANNEL_WAVE_SHAPER_OPTIONS,
          curve: leftInputForLeftOutputWaveShaperCurve
        });
        const leftInputForRightOutputGainNode = createNativeGainNode(nativeContext, { ...SINGLE_CHANNEL_OPTIONS,
          gain: 0
        }); // Bug #119: Safari does not fully support the WaveShaperNode.

        const leftInputForRightOutputWaveShaperNode = createNativeWaveShaperNode(nativeContext, { ...SINGLE_CHANNEL_WAVE_SHAPER_OPTIONS,
          curve: leftInputForRightOutputWaveShaperCurve
        }); // Bug #119: Safari does not fully support the WaveShaperNode.

        const panWaveShaperNode = createNativeWaveShaperNode(nativeContext, { ...SINGLE_CHANNEL_WAVE_SHAPER_OPTIONS,
          curve: DC_CURVE
        });
        const rightInputForLeftOutputGainNode = createNativeGainNode(nativeContext, { ...SINGLE_CHANNEL_OPTIONS,
          gain: 0
        }); // Bug #119: Safari does not fully support the WaveShaperNode.

        const rightInputForLeftOutputWaveShaperNode = createNativeWaveShaperNode(nativeContext, { ...SINGLE_CHANNEL_WAVE_SHAPER_OPTIONS,
          curve: rightInputForLeftOutputWaveShaperCurve
        });
        const rightInputForRightOutputGainNode = createNativeGainNode(nativeContext, { ...SINGLE_CHANNEL_OPTIONS,
          gain: 0
        }); // Bug #119: Safari does not fully support the WaveShaperNode.

        const rightInputForRightOutputWaveShaperNode = createNativeWaveShaperNode(nativeContext, { ...SINGLE_CHANNEL_WAVE_SHAPER_OPTIONS,
          curve: rightInputForRightOutputWaveShaperCurve
        });
        return {
          connectGraph() {
            inputGainNode.connect(channelSplitterNode);
            inputGainNode.connect(panWaveShaperNode.inputs[0]);
            channelSplitterNode.connect(leftInputForLeftOutputGainNode, 1);
            channelSplitterNode.connect(leftInputForRightOutputGainNode, 1);
            channelSplitterNode.connect(rightInputForLeftOutputGainNode, 1);
            channelSplitterNode.connect(rightInputForRightOutputGainNode, 1);
            panWaveShaperNode.connect(panGainNode);
            panGainNode.connect(leftInputForLeftOutputWaveShaperNode.inputs[0]);
            panGainNode.connect(leftInputForRightOutputWaveShaperNode.inputs[0]);
            panGainNode.connect(rightInputForLeftOutputWaveShaperNode.inputs[0]);
            panGainNode.connect(rightInputForRightOutputWaveShaperNode.inputs[0]);
            leftInputForLeftOutputWaveShaperNode.connect(leftInputForLeftOutputGainNode.gain);
            leftInputForRightOutputWaveShaperNode.connect(leftInputForRightOutputGainNode.gain);
            rightInputForLeftOutputWaveShaperNode.connect(rightInputForLeftOutputGainNode.gain);
            rightInputForRightOutputWaveShaperNode.connect(rightInputForRightOutputGainNode.gain);
            leftInputForLeftOutputGainNode.connect(channelMergerNode, 0, 0);
            rightInputForLeftOutputGainNode.connect(channelMergerNode, 0, 0);
            leftInputForRightOutputGainNode.connect(channelMergerNode, 0, 1);
            rightInputForRightOutputGainNode.connect(channelMergerNode, 0, 1);
          },

          disconnectGraph() {
            inputGainNode.disconnect(channelSplitterNode);
            inputGainNode.disconnect(panWaveShaperNode.inputs[0]);
            channelSplitterNode.disconnect(leftInputForLeftOutputGainNode, 1);
            channelSplitterNode.disconnect(leftInputForRightOutputGainNode, 1);
            channelSplitterNode.disconnect(rightInputForLeftOutputGainNode, 1);
            channelSplitterNode.disconnect(rightInputForRightOutputGainNode, 1);
            panWaveShaperNode.disconnect(panGainNode);
            panGainNode.disconnect(leftInputForLeftOutputWaveShaperNode.inputs[0]);
            panGainNode.disconnect(leftInputForRightOutputWaveShaperNode.inputs[0]);
            panGainNode.disconnect(rightInputForLeftOutputWaveShaperNode.inputs[0]);
            panGainNode.disconnect(rightInputForRightOutputWaveShaperNode.inputs[0]);
            leftInputForLeftOutputWaveShaperNode.disconnect(leftInputForLeftOutputGainNode.gain);
            leftInputForRightOutputWaveShaperNode.disconnect(leftInputForRightOutputGainNode.gain);
            rightInputForLeftOutputWaveShaperNode.disconnect(rightInputForLeftOutputGainNode.gain);
            rightInputForRightOutputWaveShaperNode.disconnect(rightInputForRightOutputGainNode.gain);
            leftInputForLeftOutputGainNode.disconnect(channelMergerNode, 0, 0);
            rightInputForLeftOutputGainNode.disconnect(channelMergerNode, 0, 0);
            leftInputForRightOutputGainNode.disconnect(channelMergerNode, 0, 1);
            rightInputForRightOutputGainNode.disconnect(channelMergerNode, 0, 1);
          }

        };
      };

      const buildInternalGraph = (nativeContext, channelCount, inputGainNode, panGainNode, channelMergerNode) => {
        if (channelCount === 1) {
          return buildInternalGraphForMono(nativeContext, inputGainNode, panGainNode, channelMergerNode);
        }

        if (channelCount === 2) {
          return buildInternalGraphForStereo(nativeContext, inputGainNode, panGainNode, channelMergerNode);
        }

        throw createNotSupportedError();
      };

      return (nativeContext, {
        channelCount,
        channelCountMode,
        pan,
        ...audioNodeOptions
      }) => {
        if (channelCountMode === 'max') {
          throw createNotSupportedError();
        }

        const channelMergerNode = createNativeChannelMergerNode(nativeContext, { ...audioNodeOptions,
          channelCount: 1,
          channelCountMode,
          numberOfInputs: 2
        });
        const inputGainNode = createNativeGainNode(nativeContext, { ...audioNodeOptions,
          channelCount,
          channelCountMode,
          gain: 1
        });
        const panGainNode = createNativeGainNode(nativeContext, {
          channelCount: 1,
          channelCountMode: 'explicit',
          channelInterpretation: 'discrete',
          gain: pan
        });
        let {
          connectGraph,
          disconnectGraph
        } = buildInternalGraph(nativeContext, channelCount, inputGainNode, panGainNode, channelMergerNode);
        Object.defineProperty(panGainNode.gain, 'defaultValue', {
          get: () => 0
        });
        const nativeStereoPannerNodeFakerFactory = {
          get bufferSize() {
            return undefined;
          },

          get channelCount() {
            return inputGainNode.channelCount;
          },

          set channelCount(value) {
            if (inputGainNode.channelCount !== value) {
              if (isConnected) {
                disconnectGraph();
              }

              ({
                connectGraph,
                disconnectGraph
              } = buildInternalGraph(nativeContext, value, inputGainNode, panGainNode, channelMergerNode));

              if (isConnected) {
                connectGraph();
              }
            }

            inputGainNode.channelCount = value;
          },

          get channelCountMode() {
            return inputGainNode.channelCountMode;
          },

          set channelCountMode(value) {
            if (value === 'clamped-max' || value === 'max') {
              throw createNotSupportedError();
            }

            inputGainNode.channelCountMode = value;
          },

          get channelInterpretation() {
            return inputGainNode.channelInterpretation;
          },

          set channelInterpretation(value) {
            inputGainNode.channelInterpretation = value;
          },

          get context() {
            return inputGainNode.context;
          },

          get inputs() {
            return [inputGainNode];
          },

          get numberOfInputs() {
            return inputGainNode.numberOfInputs;
          },

          get numberOfOutputs() {
            return inputGainNode.numberOfOutputs;
          },

          get pan() {
            return panGainNode.gain;
          },

          addEventListener(...args) {
            return inputGainNode.addEventListener(args[0], args[1], args[2]);
          },

          dispatchEvent(...args) {
            return inputGainNode.dispatchEvent(args[0]);
          },

          removeEventListener(...args) {
            return inputGainNode.removeEventListener(args[0], args[1], args[2]);
          }

        };
        let isConnected = false;

        const whenConnected = () => {
          connectGraph();
          isConnected = true;
        };

        const whenDisconnected = () => {
          disconnectGraph();
          isConnected = false;
        };

        return monitorConnections(interceptConnections(nativeStereoPannerNodeFakerFactory, channelMergerNode), whenConnected, whenDisconnected);
      };
    };

    const createNativeWaveShaperNodeFactory = (createConnectedNativeAudioBufferSourceNode, createInvalidStateError, createNativeAudioNode, createNativeWaveShaperNodeFaker, isDCCurve, monitorConnections, overwriteAccessors) => {
      return (nativeContext, options) => {
        const nativeWaveShaperNode = createNativeAudioNode(nativeContext, ntvCntxt => ntvCntxt.createWaveShaper());

        try {
          // Bug #102: Safari does not throw an InvalidStateError when the curve has less than two samples.
          // Bug #119: Safari does not correctly map the values. Bug #102 is only used to detect Safari in this case.
          nativeWaveShaperNode.curve = new Float32Array([1]);
          return createNativeWaveShaperNodeFaker(nativeContext, options);
        } catch {// Ignore errors.
        }

        assignNativeAudioNodeOptions(nativeWaveShaperNode, options);
        const curve = options.curve; // Bug #104: Chrome will throw an InvalidAccessError when the curve has less than two samples.

        if (curve !== null && curve.length < 2) {
          throw createInvalidStateError();
        }

        assignNativeAudioNodeOption(nativeWaveShaperNode, options, 'curve');
        assignNativeAudioNodeOption(nativeWaveShaperNode, options, 'oversample');
        let disconnectNativeAudioBufferSourceNode = null;
        let isConnected = false;
        overwriteAccessors(nativeWaveShaperNode, 'curve', get => () => get.call(nativeWaveShaperNode), set => value => {
          set.call(nativeWaveShaperNode, value);

          if (isConnected) {
            if (isDCCurve(value) && disconnectNativeAudioBufferSourceNode === null) {
              disconnectNativeAudioBufferSourceNode = createConnectedNativeAudioBufferSourceNode(nativeContext, nativeWaveShaperNode);
            } else if (!isDCCurve(value) && disconnectNativeAudioBufferSourceNode !== null) {
              disconnectNativeAudioBufferSourceNode();
              disconnectNativeAudioBufferSourceNode = null;
            }
          }

          return value;
        });

        const whenConnected = () => {
          isConnected = true;

          if (isDCCurve(nativeWaveShaperNode.curve)) {
            disconnectNativeAudioBufferSourceNode = createConnectedNativeAudioBufferSourceNode(nativeContext, nativeWaveShaperNode);
          }
        };

        const whenDisconnected = () => {
          isConnected = false;

          if (disconnectNativeAudioBufferSourceNode !== null) {
            disconnectNativeAudioBufferSourceNode();
            disconnectNativeAudioBufferSourceNode = null;
          }
        };

        return monitorConnections(nativeWaveShaperNode, whenConnected, whenDisconnected);
      };
    };

    const createNativeWaveShaperNodeFakerFactory = (createConnectedNativeAudioBufferSourceNode, createInvalidStateError, createNativeAudioNode, createNativeGainNode, isDCCurve, monitorConnections) => {
      return (nativeContext, {
        curve,
        oversample,
        ...audioNodeOptions
      }) => {
        const negativeWaveShaperNode = createNativeAudioNode(nativeContext, ntvCntxt => ntvCntxt.createWaveShaper());
        const positiveWaveShaperNode = createNativeAudioNode(nativeContext, ntvCntxt => ntvCntxt.createWaveShaper());
        assignNativeAudioNodeOptions(negativeWaveShaperNode, audioNodeOptions);
        assignNativeAudioNodeOptions(positiveWaveShaperNode, audioNodeOptions);
        const inputGainNode = createNativeGainNode(nativeContext, { ...audioNodeOptions,
          gain: 1
        });
        const invertGainNode = createNativeGainNode(nativeContext, { ...audioNodeOptions,
          gain: -1
        });
        const outputGainNode = createNativeGainNode(nativeContext, { ...audioNodeOptions,
          gain: 1
        });
        const revertGainNode = createNativeGainNode(nativeContext, { ...audioNodeOptions,
          gain: -1
        });
        let disconnectNativeAudioBufferSourceNode = null;
        let isConnected = false;
        let unmodifiedCurve = null;
        const nativeWaveShaperNodeFaker = {
          get bufferSize() {
            return undefined;
          },

          get channelCount() {
            return negativeWaveShaperNode.channelCount;
          },

          set channelCount(value) {
            inputGainNode.channelCount = value;
            invertGainNode.channelCount = value;
            negativeWaveShaperNode.channelCount = value;
            outputGainNode.channelCount = value;
            positiveWaveShaperNode.channelCount = value;
            revertGainNode.channelCount = value;
          },

          get channelCountMode() {
            return negativeWaveShaperNode.channelCountMode;
          },

          set channelCountMode(value) {
            inputGainNode.channelCountMode = value;
            invertGainNode.channelCountMode = value;
            negativeWaveShaperNode.channelCountMode = value;
            outputGainNode.channelCountMode = value;
            positiveWaveShaperNode.channelCountMode = value;
            revertGainNode.channelCountMode = value;
          },

          get channelInterpretation() {
            return negativeWaveShaperNode.channelInterpretation;
          },

          set channelInterpretation(value) {
            inputGainNode.channelInterpretation = value;
            invertGainNode.channelInterpretation = value;
            negativeWaveShaperNode.channelInterpretation = value;
            outputGainNode.channelInterpretation = value;
            positiveWaveShaperNode.channelInterpretation = value;
            revertGainNode.channelInterpretation = value;
          },

          get context() {
            return negativeWaveShaperNode.context;
          },

          get curve() {
            return unmodifiedCurve;
          },

          set curve(value) {
            // Bug #102: Safari does not throw an InvalidStateError when the curve has less than two samples.
            if (curve !== null && curve.length < 2) {
              throw createInvalidStateError();
            }

            if (value === null) {
              negativeWaveShaperNode.curve = value;
              positiveWaveShaperNode.curve = value;
            } else {
              const curveLength = value.length;
              const negativeCurve = new Float32Array(curveLength + 2 - curveLength % 2);
              const positiveCurve = new Float32Array(curveLength + 2 - curveLength % 2);
              negativeCurve[0] = value[0];
              positiveCurve[0] = -value[curveLength - 1];
              const length = Math.ceil((curveLength + 1) / 2);
              const centerIndex = (curveLength + 1) / 2 - 1;

              for (let i = 1; i < length; i += 1) {
                const theoreticIndex = i / length * centerIndex;
                const lowerIndex = Math.floor(theoreticIndex);
                const upperIndex = Math.ceil(theoreticIndex);
                negativeCurve[i] = lowerIndex === upperIndex ? value[lowerIndex] : (1 - (theoreticIndex - lowerIndex)) * value[lowerIndex] + (1 - (upperIndex - theoreticIndex)) * value[upperIndex];
                positiveCurve[i] = lowerIndex === upperIndex ? -value[curveLength - 1 - lowerIndex] : -((1 - (theoreticIndex - lowerIndex)) * value[curveLength - 1 - lowerIndex]) - (1 - (upperIndex - theoreticIndex)) * value[curveLength - 1 - upperIndex];
              }

              negativeCurve[length] = curveLength % 2 === 1 ? value[length - 1] : (value[length - 2] + value[length - 1]) / 2;
              negativeWaveShaperNode.curve = negativeCurve;
              positiveWaveShaperNode.curve = positiveCurve;
            }

            unmodifiedCurve = value;

            if (isConnected) {
              if (isDCCurve(unmodifiedCurve) && disconnectNativeAudioBufferSourceNode === null) {
                disconnectNativeAudioBufferSourceNode = createConnectedNativeAudioBufferSourceNode(nativeContext, inputGainNode);
              } else if (disconnectNativeAudioBufferSourceNode !== null) {
                disconnectNativeAudioBufferSourceNode();
                disconnectNativeAudioBufferSourceNode = null;
              }
            }
          },

          get inputs() {
            return [inputGainNode];
          },

          get numberOfInputs() {
            return negativeWaveShaperNode.numberOfInputs;
          },

          get numberOfOutputs() {
            return negativeWaveShaperNode.numberOfOutputs;
          },

          get oversample() {
            return negativeWaveShaperNode.oversample;
          },

          set oversample(value) {
            negativeWaveShaperNode.oversample = value;
            positiveWaveShaperNode.oversample = value;
          },

          addEventListener(...args) {
            return inputGainNode.addEventListener(args[0], args[1], args[2]);
          },

          dispatchEvent(...args) {
            return inputGainNode.dispatchEvent(args[0]);
          },

          removeEventListener(...args) {
            return inputGainNode.removeEventListener(args[0], args[1], args[2]);
          }

        };

        if (curve !== nativeWaveShaperNodeFaker.curve) {
          nativeWaveShaperNodeFaker.curve = curve;
        }

        if (oversample !== nativeWaveShaperNodeFaker.oversample) {
          nativeWaveShaperNodeFaker.oversample = oversample;
        }

        const whenConnected = () => {
          inputGainNode.connect(negativeWaveShaperNode).connect(outputGainNode);
          inputGainNode.connect(invertGainNode).connect(positiveWaveShaperNode).connect(revertGainNode).connect(outputGainNode);
          isConnected = true;

          if (isDCCurve(unmodifiedCurve)) {
            disconnectNativeAudioBufferSourceNode = createConnectedNativeAudioBufferSourceNode(nativeContext, inputGainNode);
          }
        };

        const whenDisconnected = () => {
          inputGainNode.disconnect(negativeWaveShaperNode);
          negativeWaveShaperNode.disconnect(outputGainNode);
          inputGainNode.disconnect(invertGainNode);
          invertGainNode.disconnect(positiveWaveShaperNode);
          positiveWaveShaperNode.disconnect(revertGainNode);
          revertGainNode.disconnect(outputGainNode);
          isConnected = false;

          if (disconnectNativeAudioBufferSourceNode !== null) {
            disconnectNativeAudioBufferSourceNode();
            disconnectNativeAudioBufferSourceNode = null;
          }
        };

        return monitorConnections(interceptConnections(nativeWaveShaperNodeFaker, outputGainNode), whenConnected, whenDisconnected);
      };
    };

    const createNotSupportedError = () => {
      try {
        return new DOMException('', 'NotSupportedError');
      } catch (err) {
        // Bug #122: Edge is the only browser that does not yet allow to construct a DOMException.
        err.code = 9;
        err.name = 'NotSupportedError';
        return err;
      }
    };

    const DEFAULT_OPTIONS$f = {
      numberOfChannels: 1
    };
    const createOfflineAudioContextConstructor = (baseAudioContextConstructor, cacheTestResult, createInvalidStateError, createNativeOfflineAudioContext, startRendering) => {
      return class OfflineAudioContext extends baseAudioContextConstructor {
        constructor(a, b, c) {
          let options;

          if (typeof a === 'number' && b !== undefined && c !== undefined) {
            options = {
              length: b,
              numberOfChannels: a,
              sampleRate: c
            };
          } else if (typeof a === 'object') {
            options = a;
          } else {
            throw new Error('The given parameters are not valid.');
          }

          const {
            length,
            numberOfChannels,
            sampleRate
          } = { ...DEFAULT_OPTIONS$f,
            ...options
          };
          const nativeOfflineAudioContext = createNativeOfflineAudioContext(numberOfChannels, length, sampleRate); // #21 Safari does not support promises and therefore would fire the statechange event before the promise can be resolved.

          if (!cacheTestResult(testPromiseSupport, () => testPromiseSupport(nativeOfflineAudioContext))) {
            nativeOfflineAudioContext.addEventListener('statechange', (() => {
              let i = 0;

              const delayStateChangeEvent = event => {
                if (this._state === 'running') {
                  if (i > 0) {
                    nativeOfflineAudioContext.removeEventListener('statechange', delayStateChangeEvent);
                    event.stopImmediatePropagation();

                    this._waitForThePromiseToSettle(event);
                  } else {
                    i += 1;
                  }
                }
              };

              return delayStateChangeEvent;
            })());
          }

          super(nativeOfflineAudioContext, numberOfChannels);
          this._length = length;
          this._nativeOfflineAudioContext = nativeOfflineAudioContext;
          this._state = null;
        }

        get length() {
          // Bug #17: Safari does not yet expose the length.
          if (this._nativeOfflineAudioContext.length === undefined) {
            return this._length;
          }

          return this._nativeOfflineAudioContext.length;
        }

        get state() {
          return this._state === null ? this._nativeOfflineAudioContext.state : this._state;
        }

        startRendering() {
          /*
           * Bug #9 & #59: It is theoretically possible that startRendering() will first render a partialOfflineAudioContext. Therefore
           * the state of the nativeOfflineAudioContext might no transition to running immediately.
           */
          if (this._state === 'running') {
            return Promise.reject(createInvalidStateError());
          }

          this._state = 'running';
          return startRendering(this.destination, this._nativeOfflineAudioContext).then(audioBuffer => {
            this._state = null;
            /*
             * Bug #50: Deleting the AudioGraph is currently not possible anymore.
             * deleteAudioGraph(this, this._nativeOfflineAudioContext);
             */

            return audioBuffer;
          }) // @todo This could be written more elegantly when Promise.finally() becomes avalaible.
          .catch(err => {
            this._state = null;
            /*
             * Bug #50: Deleting the AudioGraph is currently not possible anymore.
             * deleteAudioGraph(this, this._nativeOfflineAudioContext);
             */

            throw err;
          });
        }

        _waitForThePromiseToSettle(event) {
          if (this._state === null) {
            this._nativeOfflineAudioContext.dispatchEvent(event);
          } else {
            setTimeout(() => this._waitForThePromiseToSettle(event));
          }
        }

      };
    };

    const DEFAULT_OPTIONS$g = {
      channelCount: 2,
      channelCountMode: 'max',
      channelInterpretation: 'speakers',
      detune: 0,
      frequency: 440,
      type: 'sine'
    };
    const createOscillatorNodeConstructor = (audioNodeConstructor, createAudioParam, createInvalidStateError, createNativeOscillatorNode, createOscillatorNodeRenderer, getNativeContext, isNativeOfflineAudioContext, wrapEventListener) => {
      return class OscillatorNode extends audioNodeConstructor {
        constructor(context, options = DEFAULT_OPTIONS$g) {
          const nativeContext = getNativeContext(context);
          const mergedOptions = { ...DEFAULT_OPTIONS$g,
            ...options
          };
          const nativeOscillatorNode = createNativeOscillatorNode(nativeContext, mergedOptions);
          const isOffline = isNativeOfflineAudioContext(nativeContext);
          const oscillatorNodeRenderer = isOffline ? createOscillatorNodeRenderer() : null;
          const nyquist = context.sampleRate / 2;
          super(context, false, nativeOscillatorNode, oscillatorNodeRenderer); // Bug #81: Edge, Firefox & Safari do not export the correct values for maxValue and minValue.

          this._detune = createAudioParam(this, isOffline, nativeOscillatorNode.detune, 153600, -153600); // Bug #76: Edge & Safari do not export the correct values for maxValue and minValue.

          this._frequency = createAudioParam(this, isOffline, nativeOscillatorNode.frequency, nyquist, -nyquist);
          this._nativeOscillatorNode = nativeOscillatorNode;
          this._onended = null;
          this._oscillatorNodeRenderer = oscillatorNodeRenderer;

          if (this._oscillatorNodeRenderer !== null && mergedOptions.periodicWave !== undefined) {
            this._oscillatorNodeRenderer.periodicWave = mergedOptions.periodicWave;
          }
        }

        get detune() {
          return this._detune;
        }

        get frequency() {
          return this._frequency;
        }

        get onended() {
          return this._onended;
        }

        set onended(value) {
          const wrappedListener = typeof value === 'function' ? wrapEventListener(this, value) : null;
          this._nativeOscillatorNode.onended = wrappedListener;
          const nativeOnEnded = this._nativeOscillatorNode.onended;
          this._onended = nativeOnEnded !== null && nativeOnEnded === wrappedListener ? value : nativeOnEnded;
        }

        get type() {
          return this._nativeOscillatorNode.type;
        }

        set type(value) {
          this._nativeOscillatorNode.type = value; // Bug #57: Edge will not throw an error when assigning the type to 'custom'. But it still will change the value.

          if (value === 'custom') {
            throw createInvalidStateError();
          }

          if (this._oscillatorNodeRenderer !== null) {
            this._oscillatorNodeRenderer.periodicWave = null;
          }
        }

        setPeriodicWave(periodicWave) {
          this._nativeOscillatorNode.setPeriodicWave(periodicWave);

          if (this._oscillatorNodeRenderer !== null) {
            this._oscillatorNodeRenderer.periodicWave = periodicWave;
          }
        }

        start(when = 0) {
          this._nativeOscillatorNode.start(when);

          if (this._oscillatorNodeRenderer !== null) {
            this._oscillatorNodeRenderer.start = when;
          } else {
            setInternalStateToActive(this);

            const resetInternalStateToPassive = () => {
              this._nativeOscillatorNode.removeEventListener('ended', resetInternalStateToPassive); // @todo Determine a meaningful delay instead of just using one second.


              setTimeout(() => setInternalStateToPassive(this), 1000);
            };

            this._nativeOscillatorNode.addEventListener('ended', resetInternalStateToPassive);
          }
        }

        stop(when = 0) {
          this._nativeOscillatorNode.stop(when);

          if (this._oscillatorNodeRenderer !== null) {
            this._oscillatorNodeRenderer.stop = when;
          }
        }

      };
    };

    const createOscillatorNodeRendererFactory = (connectAudioParam, createNativeOscillatorNode, getNativeAudioNode, renderAutomation, renderInputsOfAudioNode) => {
      return () => {
        const renderedNativeOscillatorNodes = new WeakMap();
        let periodicWave = null;
        let start = null;
        let stop = null;

        const createOscillatorNode = async (proxy, nativeOfflineAudioContext, trace) => {
          let nativeOscillatorNode = getNativeAudioNode(proxy); // If the initially used nativeOscillatorNode was not constructed on the same OfflineAudioContext it needs to be created again.

          const nativeOscillatorNodeIsOwnedByContext = isOwnedByContext(nativeOscillatorNode, nativeOfflineAudioContext);

          if (!nativeOscillatorNodeIsOwnedByContext) {
            const options = {
              channelCount: nativeOscillatorNode.channelCount,
              channelCountMode: nativeOscillatorNode.channelCountMode,
              channelInterpretation: nativeOscillatorNode.channelInterpretation,
              detune: nativeOscillatorNode.detune.value,
              frequency: nativeOscillatorNode.frequency.value,
              periodicWave: periodicWave === null ? undefined : periodicWave,
              type: nativeOscillatorNode.type
            };
            nativeOscillatorNode = createNativeOscillatorNode(nativeOfflineAudioContext, options);

            if (start !== null) {
              nativeOscillatorNode.start(start);
            }

            if (stop !== null) {
              nativeOscillatorNode.stop(stop);
            }
          }

          renderedNativeOscillatorNodes.set(nativeOfflineAudioContext, nativeOscillatorNode);

          if (!nativeOscillatorNodeIsOwnedByContext) {
            await renderAutomation(nativeOfflineAudioContext, proxy.detune, nativeOscillatorNode.detune, trace);
            await renderAutomation(nativeOfflineAudioContext, proxy.frequency, nativeOscillatorNode.frequency, trace);
          } else {
            await connectAudioParam(nativeOfflineAudioContext, proxy.detune, nativeOscillatorNode.detune, trace);
            await connectAudioParam(nativeOfflineAudioContext, proxy.frequency, nativeOscillatorNode.frequency, trace);
          }

          await renderInputsOfAudioNode(proxy, nativeOfflineAudioContext, nativeOscillatorNode, trace);
          return nativeOscillatorNode;
        };

        return {
          set periodicWave(value) {
            periodicWave = value;
          },

          set start(value) {
            start = value;
          },

          set stop(value) {
            stop = value;
          },

          render(proxy, nativeOfflineAudioContext, trace) {
            const renderedNativeOscillatorNode = renderedNativeOscillatorNodes.get(nativeOfflineAudioContext);

            if (renderedNativeOscillatorNode !== undefined) {
              return Promise.resolve(renderedNativeOscillatorNode);
            }

            return createOscillatorNode(proxy, nativeOfflineAudioContext, trace);
          }

        };
      };
    };

    const DEFAULT_OPTIONS$h = {
      channelCount: 2,
      channelCountMode: 'clamped-max',
      channelInterpretation: 'speakers',
      coneInnerAngle: 360,
      coneOuterAngle: 360,
      coneOuterGain: 0,
      distanceModel: 'inverse',
      maxDistance: 10000,
      orientationX: 1,
      orientationY: 0,
      orientationZ: 0,
      panningModel: 'equalpower',
      positionX: 0,
      positionY: 0,
      positionZ: 0,
      refDistance: 1,
      rolloffFactor: 1
    };
    const createPannerNodeConstructor = (audioNodeConstructor, createAudioParam, createNativePannerNode, createPannerNodeRenderer, getNativeContext, isNativeOfflineAudioContext) => {
      return class PannerNode extends audioNodeConstructor {
        constructor(context, options = DEFAULT_OPTIONS$h) {
          const nativeContext = getNativeContext(context);
          const mergedOptions = { ...DEFAULT_OPTIONS$h,
            ...options
          };
          const nativePannerNode = createNativePannerNode(nativeContext, mergedOptions);
          const isOffline = isNativeOfflineAudioContext(nativeContext);
          const pannerNodeRenderer = isOffline ? createPannerNodeRenderer() : null;
          super(context, false, nativePannerNode, pannerNodeRenderer);
          this._nativePannerNode = nativePannerNode; // Bug #74: Edge & Safari do not export the correct values for maxValue and minValue for GainNodes.

          this._orientationX = createAudioParam(this, isOffline, nativePannerNode.orientationX, MOST_POSITIVE_SINGLE_FLOAT, MOST_NEGATIVE_SINGLE_FLOAT);
          this._orientationY = createAudioParam(this, isOffline, nativePannerNode.orientationY, MOST_POSITIVE_SINGLE_FLOAT, MOST_NEGATIVE_SINGLE_FLOAT);
          this._orientationZ = createAudioParam(this, isOffline, nativePannerNode.orientationZ, MOST_POSITIVE_SINGLE_FLOAT, MOST_NEGATIVE_SINGLE_FLOAT);
          this._positionX = createAudioParam(this, isOffline, nativePannerNode.positionX, MOST_POSITIVE_SINGLE_FLOAT, MOST_NEGATIVE_SINGLE_FLOAT);
          this._positionY = createAudioParam(this, isOffline, nativePannerNode.positionY, MOST_POSITIVE_SINGLE_FLOAT, MOST_NEGATIVE_SINGLE_FLOAT);
          this._positionZ = createAudioParam(this, isOffline, nativePannerNode.positionZ, MOST_POSITIVE_SINGLE_FLOAT, MOST_NEGATIVE_SINGLE_FLOAT);
        }

        get coneInnerAngle() {
          return this._nativePannerNode.coneInnerAngle;
        }

        set coneInnerAngle(value) {
          this._nativePannerNode.coneInnerAngle = value;
        }

        get coneOuterAngle() {
          return this._nativePannerNode.coneOuterAngle;
        }

        set coneOuterAngle(value) {
          this._nativePannerNode.coneOuterAngle = value;
        }

        get coneOuterGain() {
          return this._nativePannerNode.coneOuterGain;
        }

        set coneOuterGain(value) {
          this._nativePannerNode.coneOuterGain = value;
        }

        get distanceModel() {
          return this._nativePannerNode.distanceModel;
        }

        set distanceModel(value) {
          this._nativePannerNode.distanceModel = value;
        }

        get maxDistance() {
          return this._nativePannerNode.maxDistance;
        }

        set maxDistance(value) {
          this._nativePannerNode.maxDistance = value;
        }

        get orientationX() {
          return this._orientationX;
        }

        get orientationY() {
          return this._orientationY;
        }

        get orientationZ() {
          return this._orientationZ;
        }

        get panningModel() {
          return this._nativePannerNode.panningModel;
        }

        set panningModel(value) {
          this._nativePannerNode.panningModel = value;
        }

        get positionX() {
          return this._positionX;
        }

        get positionY() {
          return this._positionY;
        }

        get positionZ() {
          return this._positionZ;
        }

        get refDistance() {
          return this._nativePannerNode.refDistance;
        }

        set refDistance(value) {
          this._nativePannerNode.refDistance = value;
        }

        get rolloffFactor() {
          return this._nativePannerNode.rolloffFactor;
        }

        set rolloffFactor(value) {
          this._nativePannerNode.rolloffFactor = value;
        }

      };
    };

    const createPannerNodeRendererFactory = (connectAudioParam, createNativeChannelMergerNode, createNativeConstantSourceNode, createNativeGainNode, createNativePannerNode, getNativeAudioNode, nativeOfflineAudioContextConstructor, renderAutomation, renderInputsOfAudioNode, renderNativeOfflineAudioContext) => {
      return () => {
        const renderedNativeAudioNodes = new WeakMap();
        let renderedBufferPromise = null;

        const createAudioNode = async (proxy, nativeOfflineAudioContext, trace) => {
          let nativeGainNode = null;
          let nativePannerNode = getNativeAudioNode(proxy);
          const commonAudioNodeOptions = {
            channelCount: nativePannerNode.channelCount,
            channelCountMode: nativePannerNode.channelCountMode,
            channelInterpretation: nativePannerNode.channelInterpretation
          };
          const commonNativePannerNodeOptions = { ...commonAudioNodeOptions,
            coneInnerAngle: nativePannerNode.coneInnerAngle,
            coneOuterAngle: nativePannerNode.coneOuterAngle,
            coneOuterGain: nativePannerNode.coneOuterGain,
            distanceModel: nativePannerNode.distanceModel,
            maxDistance: nativePannerNode.maxDistance,
            panningModel: nativePannerNode.panningModel,
            refDistance: nativePannerNode.refDistance,
            rolloffFactor: nativePannerNode.rolloffFactor
          }; // If the initially used nativePannerNode was not constructed on the same OfflineAudioContext it needs to be created again.

          const nativePannerNodeIsOwnedByContext = isOwnedByContext(nativePannerNode, nativeOfflineAudioContext); // Bug #124: Edge & Safari do not support modifying the orientation and the position with AudioParams.

          if ('bufferSize' in nativePannerNode) {
            nativeGainNode = createNativeGainNode(nativeOfflineAudioContext, { ...commonAudioNodeOptions,
              gain: 1
            });
          } else if (!nativePannerNodeIsOwnedByContext) {
            const options = { ...commonNativePannerNodeOptions,
              orientationX: nativePannerNode.orientationX.value,
              orientationY: nativePannerNode.orientationY.value,
              orientationZ: nativePannerNode.orientationZ.value,
              positionX: nativePannerNode.positionX.value,
              positionY: nativePannerNode.positionY.value,
              positionZ: nativePannerNode.positionZ.value
            };
            nativePannerNode = createNativePannerNode(nativeOfflineAudioContext, options);
          }

          renderedNativeAudioNodes.set(nativeOfflineAudioContext, nativeGainNode === null ? nativePannerNode : nativeGainNode);

          if (nativeGainNode !== null) {
            if (renderedBufferPromise === null) {
              if (nativeOfflineAudioContextConstructor === null) {
                throw new Error('Missing the native OfflineAudioContext constructor.');
              }

              const partialOfflineAudioContext = new nativeOfflineAudioContextConstructor(6, // Bug #17: Safari does not yet expose the length.
              proxy.context.length, nativeOfflineAudioContext.sampleRate);
              const nativeChannelMergerNode = createNativeChannelMergerNode(partialOfflineAudioContext, {
                channelCount: 1,
                channelCountMode: 'explicit',
                channelInterpretation: 'speakers',
                numberOfInputs: 6
              });
              nativeChannelMergerNode.connect(partialOfflineAudioContext.destination);

              renderedBufferPromise = (async () => {
                const nativeConstantSourceNodes = await Promise.all([proxy.orientationX, proxy.orientationY, proxy.orientationZ, proxy.positionX, proxy.positionY, proxy.positionZ].map(async (audioParam, index) => {
                  const nativeConstantSourceNode = createNativeConstantSourceNode(partialOfflineAudioContext, {
                    channelCount: 1,
                    channelCountMode: 'explicit',
                    channelInterpretation: 'discrete',
                    offset: index === 0 ? 1 : 0
                  });
                  await renderAutomation(partialOfflineAudioContext, audioParam, nativeConstantSourceNode.offset, trace);
                  return nativeConstantSourceNode;
                }));

                for (let i = 0; i < 6; i += 1) {
                  nativeConstantSourceNodes[i].connect(nativeChannelMergerNode, 0, i);
                  nativeConstantSourceNodes[i].start(0);
                }

                return renderNativeOfflineAudioContext(partialOfflineAudioContext);
              })();
            }

            const renderedBuffer = await renderedBufferPromise;
            const inputGainNode = createNativeGainNode(nativeOfflineAudioContext, { ...commonAudioNodeOptions,
              gain: 1
            });
            await renderInputsOfAudioNode(proxy, nativeOfflineAudioContext, inputGainNode, trace);
            const channelDatas = [];

            for (let i = 0; i < renderedBuffer.numberOfChannels; i += 1) {
              channelDatas.push(renderedBuffer.getChannelData(i));
            }

            let lastOrientation = [channelDatas[0][0], channelDatas[1][0], channelDatas[2][0]];
            let lastPosition = [channelDatas[3][0], channelDatas[4][0], channelDatas[5][0]];
            let gateGainNode = createNativeGainNode(nativeOfflineAudioContext, { ...commonAudioNodeOptions,
              gain: 1
            });
            let partialPannerNode = createNativePannerNode(nativeOfflineAudioContext, { ...commonNativePannerNodeOptions,
              orientationX: lastOrientation[0],
              orientationY: lastOrientation[1],
              orientationZ: lastOrientation[2],
              positionX: lastPosition[0],
              positionY: lastPosition[1],
              positionZ: lastPosition[2]
            });
            inputGainNode.connect(gateGainNode).connect(partialPannerNode.inputs[0]);
            partialPannerNode.connect(nativeGainNode);

            for (let i = 128; i < renderedBuffer.length; i += 128) {
              const orientation = [channelDatas[0][i], channelDatas[1][i], channelDatas[2][i]];
              const positon = [channelDatas[3][i], channelDatas[4][i], channelDatas[5][i]];

              if (orientation.some((value, index) => value !== lastOrientation[index]) || positon.some((value, index) => value !== lastPosition[index])) {
                lastOrientation = orientation;
                lastPosition = positon;
                const currentTime = i / nativeOfflineAudioContext.sampleRate;
                gateGainNode.gain.setValueAtTime(0, currentTime);
                gateGainNode = createNativeGainNode(nativeOfflineAudioContext, { ...commonAudioNodeOptions,
                  gain: 0
                });
                partialPannerNode = createNativePannerNode(nativeOfflineAudioContext, { ...commonNativePannerNodeOptions,
                  orientationX: lastOrientation[0],
                  orientationY: lastOrientation[1],
                  orientationZ: lastOrientation[2],
                  positionX: lastPosition[0],
                  positionY: lastPosition[1],
                  positionZ: lastPosition[2]
                });
                gateGainNode.gain.setValueAtTime(1, currentTime);
                inputGainNode.connect(gateGainNode).connect(partialPannerNode.inputs[0]);
                partialPannerNode.connect(nativeGainNode);
              }
            }

            return nativeGainNode;
          }

          if (!nativePannerNodeIsOwnedByContext) {
            await renderAutomation(nativeOfflineAudioContext, proxy.orientationX, nativePannerNode.orientationX, trace);
            await renderAutomation(nativeOfflineAudioContext, proxy.orientationY, nativePannerNode.orientationY, trace);
            await renderAutomation(nativeOfflineAudioContext, proxy.orientationZ, nativePannerNode.orientationZ, trace);
            await renderAutomation(nativeOfflineAudioContext, proxy.positionX, nativePannerNode.positionX, trace);
            await renderAutomation(nativeOfflineAudioContext, proxy.positionY, nativePannerNode.positionY, trace);
            await renderAutomation(nativeOfflineAudioContext, proxy.positionZ, nativePannerNode.positionZ, trace);
          } else {
            await connectAudioParam(nativeOfflineAudioContext, proxy.orientationX, nativePannerNode.orientationX, trace);
            await connectAudioParam(nativeOfflineAudioContext, proxy.orientationY, nativePannerNode.orientationY, trace);
            await connectAudioParam(nativeOfflineAudioContext, proxy.orientationZ, nativePannerNode.orientationZ, trace);
            await connectAudioParam(nativeOfflineAudioContext, proxy.positionX, nativePannerNode.positionX, trace);
            await connectAudioParam(nativeOfflineAudioContext, proxy.positionY, nativePannerNode.positionY, trace);
            await connectAudioParam(nativeOfflineAudioContext, proxy.positionZ, nativePannerNode.positionZ, trace);
          }

          if (isNativeAudioNodeFaker(nativePannerNode)) {
            await renderInputsOfAudioNode(proxy, nativeOfflineAudioContext, nativePannerNode.inputs[0], trace);
          } else {
            await renderInputsOfAudioNode(proxy, nativeOfflineAudioContext, nativePannerNode, trace);
          }

          return nativePannerNode;
        };

        return {
          render(proxy, nativeOfflineAudioContext, trace) {
            const renderedNativeGainNodeOrNativePannerNode = renderedNativeAudioNodes.get(nativeOfflineAudioContext);

            if (renderedNativeGainNodeOrNativePannerNode !== undefined) {
              return Promise.resolve(renderedNativeGainNodeOrNativePannerNode);
            }

            return createAudioNode(proxy, nativeOfflineAudioContext, trace);
          }

        };
      };
    };

    const DEFAULT_OPTIONS$i = {
      disableNormalization: false
    };
    const createPeriodicWaveConstructor = (createNativePeriodicWave, getNativeContext, periodicWaveStore) => {
      return class PeriodicWave {
        constructor(context, options) {
          const nativeContext = getNativeContext(context);
          const mergedOptions = { ...DEFAULT_OPTIONS$i,
            ...options
          };
          const periodicWave = createNativePeriodicWave(nativeContext, mergedOptions);
          periodicWaveStore.add(periodicWave); // This does violate all good pratices but it is used here to simplify the handling of periodic waves.

          return periodicWave;
        }

        static [Symbol.hasInstance](instance) {
          return instance !== null && typeof instance === 'object' && Object.getPrototypeOf(instance) === PeriodicWave.prototype || periodicWaveStore.has(instance);
        }

      };
    };

    const createRenderAutomation = (getAudioParamRenderer, renderInputsOfAudioParam) => {
      return (nativeOfflineAudioContext, audioParam, nativeAudioParam, trace) => {
        const audioParamRenderer = getAudioParamRenderer(audioParam);
        audioParamRenderer.replay(nativeAudioParam);
        return renderInputsOfAudioParam(audioParam, nativeOfflineAudioContext, nativeAudioParam, trace);
      };
    };

    const createRenderInputsOfAudioNode = (getAudioNodeConnections, getAudioNodeRenderer, isPartOfACycle) => {
      return async (audioNode, nativeOfflineAudioContext, nativeAudioNode, trace) => {
        const audioNodeConnections = getAudioNodeConnections(audioNode);
        const nextTrace = [...trace, audioNode];
        await Promise.all(audioNodeConnections.activeInputs.map((connections, input) => Array.from(connections).filter(([source]) => !nextTrace.includes(source)).map(async ([source, output]) => {
          const audioNodeRenderer = getAudioNodeRenderer(source);
          const renderedNativeAudioNode = await audioNodeRenderer.render(source, nativeOfflineAudioContext, nextTrace);
          const destination = audioNode.context.destination;

          if (!isPartOfACycle(source) && (audioNode !== destination || !isPartOfACycle(audioNode))) {
            renderedNativeAudioNode.connect(nativeAudioNode, output, input);
          }
        })).reduce((allRenderingPromises, renderingPromises) => [...allRenderingPromises, ...renderingPromises], []));
      };
    };

    const createRenderInputsOfAudioParam = (getAudioNodeRenderer, getAudioParamConnections, isPartOfACycle) => {
      return async (audioParam, nativeOfflineAudioContext, nativeAudioParam, trace) => {
        const audioParamConnections = getAudioParamConnections(audioParam);
        await Promise.all(Array.from(audioParamConnections.activeInputs).map(async ([source, output]) => {
          const audioNodeRenderer = getAudioNodeRenderer(source);
          const renderedNativeAudioNode = await audioNodeRenderer.render(source, nativeOfflineAudioContext, trace);

          if (!isPartOfACycle(source)) {
            renderedNativeAudioNode.connect(nativeAudioParam, output);
          }
        }));
      };
    };

    const createRenderNativeOfflineAudioContext = (cacheTestResult, createNativeGainNode, createNativeScriptProcessorNode, testOfflineAudioContextCurrentTimeSupport) => {
      return nativeOfflineAudioContext => {
        // Bug #21: Safari does not support promises yet.
        if (cacheTestResult(testPromiseSupport, () => testPromiseSupport(nativeOfflineAudioContext))) {
          // Bug #158: Edge does not advance currentTime if it is not accessed while rendering the audio.
          return Promise.resolve(cacheTestResult(testOfflineAudioContextCurrentTimeSupport, testOfflineAudioContextCurrentTimeSupport)).then(isOfflineAudioContextCurrentTimeSupported => {
            if (!isOfflineAudioContextCurrentTimeSupported) {
              const scriptProcessorNode = createNativeScriptProcessorNode(nativeOfflineAudioContext, 512, 0, 1);

              nativeOfflineAudioContext.oncomplete = () => {
                scriptProcessorNode.onaudioprocess = null; // tslint:disable-line:deprecation

                scriptProcessorNode.disconnect();
              };

              scriptProcessorNode.onaudioprocess = () => nativeOfflineAudioContext.currentTime; // tslint:disable-line:deprecation


              scriptProcessorNode.connect(nativeOfflineAudioContext.destination);
            }

            return nativeOfflineAudioContext.startRendering();
          });
        }

        return new Promise(resolve => {
          // Bug #48: Safari does not render an OfflineAudioContext without any connected node.
          const gainNode = createNativeGainNode(nativeOfflineAudioContext, {
            channelCount: 1,
            channelCountMode: 'explicit',
            channelInterpretation: 'discrete',
            gain: 0
          });

          nativeOfflineAudioContext.oncomplete = event => {
            gainNode.disconnect();
            resolve(event.renderedBuffer);
          };

          gainNode.connect(nativeOfflineAudioContext.destination);
          nativeOfflineAudioContext.startRendering();
        });
      };
    };

    const createStartRendering = (audioBufferStore, cacheTestResult, getAudioNodeRenderer, getUnrenderedAudioWorkletNodes, renderNativeOfflineAudioContext, testAudioBufferCopyChannelMethodsOutOfBoundsSupport, wrapAudioBufferCopyChannelMethods, wrapAudioBufferCopyChannelMethodsOutOfBounds) => {
      const trace = [];
      return (destination, nativeOfflineAudioContext) => getAudioNodeRenderer(destination).render(destination, nativeOfflineAudioContext, trace)
      /*
       * Bug #86 & #87: Invoking the renderer of an AudioWorkletNode might be necessary if it has no direct or indirect connection to the
       * destination.
       */
      .then(() => Promise.all(Array.from(getUnrenderedAudioWorkletNodes(nativeOfflineAudioContext)).map(audioWorkletNode => getAudioNodeRenderer(audioWorkletNode).render(audioWorkletNode, nativeOfflineAudioContext, trace)))).then(() => renderNativeOfflineAudioContext(nativeOfflineAudioContext)).then(audioBuffer => {
        // Bug #5: Safari does not support copyFromChannel() and copyToChannel().
        // Bug #100: Safari does throw a wrong error when calling getChannelData() with an out-of-bounds value.
        if (typeof audioBuffer.copyFromChannel !== 'function') {
          wrapAudioBufferCopyChannelMethods(audioBuffer);
          wrapAudioBufferGetChannelDataMethod(audioBuffer); // Bug #157: Only Chrome & Opera do allow the bufferOffset to be out-of-bounds.
        } else if (!cacheTestResult(testAudioBufferCopyChannelMethodsOutOfBoundsSupport, () => testAudioBufferCopyChannelMethodsOutOfBoundsSupport(audioBuffer))) {
          wrapAudioBufferCopyChannelMethodsOutOfBounds(audioBuffer);
        }

        audioBufferStore.add(audioBuffer);
        return audioBuffer;
      });
    };

    const DEFAULT_OPTIONS$j = {
      channelCount: 2,

      /*
       * Bug #105: The channelCountMode should be 'clamped-max' according to the spec but is set to 'explicit' to achieve consistent
       * behavior.
       */
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      pan: 0
    };
    const createStereoPannerNodeConstructor = (audioNodeConstructor, createAudioParam, createNativeStereoPannerNode, createStereoPannerNodeRenderer, getNativeContext, isNativeOfflineAudioContext) => {
      return class StereoPannerNode extends audioNodeConstructor {
        constructor(context, options = DEFAULT_OPTIONS$j) {
          const nativeContext = getNativeContext(context);
          const mergedOptions = { ...DEFAULT_OPTIONS$j,
            ...options
          };
          const nativeStereoPannerNode = createNativeStereoPannerNode(nativeContext, mergedOptions);
          const isOffline = isNativeOfflineAudioContext(nativeContext);
          const stereoPannerNodeRenderer = isOffline ? createStereoPannerNodeRenderer() : null;
          super(context, false, nativeStereoPannerNode, stereoPannerNodeRenderer); // Bug #106: Edge does not export a maxValue and minValue property.

          this._pan = createAudioParam(this, isOffline, nativeStereoPannerNode.pan, 1, -1);
        }

        get pan() {
          return this._pan;
        }

      };
    };

    const createStereoPannerNodeRendererFactory = (connectAudioParam, createNativeStereoPannerNode, getNativeAudioNode, renderAutomation, renderInputsOfAudioNode) => {
      return () => {
        const renderedNativeStereoPannerNodes = new WeakMap();

        const createStereoPannerNode = async (proxy, nativeOfflineAudioContext, trace) => {
          let nativeStereoPannerNode = getNativeAudioNode(proxy);
          /*
           * If the initially used nativeStereoPannerNode was not constructed on the same OfflineAudioContext it needs to be created
           * again.
           */

          const nativeStereoPannerNodeIsOwnedByContext = isOwnedByContext(nativeStereoPannerNode, nativeOfflineAudioContext);

          if (!nativeStereoPannerNodeIsOwnedByContext) {
            const options = {
              channelCount: nativeStereoPannerNode.channelCount,
              channelCountMode: nativeStereoPannerNode.channelCountMode,
              channelInterpretation: nativeStereoPannerNode.channelInterpretation,
              pan: nativeStereoPannerNode.pan.value
            };
            nativeStereoPannerNode = createNativeStereoPannerNode(nativeOfflineAudioContext, options);
          }

          renderedNativeStereoPannerNodes.set(nativeOfflineAudioContext, nativeStereoPannerNode);

          if (!nativeStereoPannerNodeIsOwnedByContext) {
            await renderAutomation(nativeOfflineAudioContext, proxy.pan, nativeStereoPannerNode.pan, trace);
          } else {
            await connectAudioParam(nativeOfflineAudioContext, proxy.pan, nativeStereoPannerNode.pan, trace);
          }

          if (isNativeAudioNodeFaker(nativeStereoPannerNode)) {
            await renderInputsOfAudioNode(proxy, nativeOfflineAudioContext, nativeStereoPannerNode.inputs[0], trace);
          } else {
            await renderInputsOfAudioNode(proxy, nativeOfflineAudioContext, nativeStereoPannerNode, trace);
          }

          return nativeStereoPannerNode;
        };

        return {
          render(proxy, nativeOfflineAudioContext, trace) {
            const renderedNativeStereoPannerNode = renderedNativeStereoPannerNodes.get(nativeOfflineAudioContext);

            if (renderedNativeStereoPannerNode !== undefined) {
              return Promise.resolve(renderedNativeStereoPannerNode);
            }

            return createStereoPannerNode(proxy, nativeOfflineAudioContext, trace);
          }

        };
      };
    };

    // Bug #33: Edge & Safari expose an AudioBuffer but it can't be used as a constructor.
    const createTestAudioBufferConstructorSupport = nativeAudioBufferConstructor => {
      return () => {
        if (nativeAudioBufferConstructor === null) {
          return false;
        }

        try {
          new nativeAudioBufferConstructor({
            length: 1,
            sampleRate: 44100
          }); // tslint:disable-line:no-unused-expression
        } catch {
          return false;
        }

        return true;
      };
    };

    /*
     * Firefox up to version 67 didn't fully support the copyFromChannel() and copyToChannel() methods. Therefore testing one of those methods
     * is enough to know if the other one is supported as well.
     */
    const createTestAudioBufferCopyChannelMethodsSubarraySupport = nativeOfflineAudioContextConstructor => {
      return () => {
        if (nativeOfflineAudioContextConstructor === null) {
          return false;
        }

        const nativeOfflineAudioContext = new nativeOfflineAudioContextConstructor(1, 1, 44100);
        const nativeAudioBuffer = nativeOfflineAudioContext.createBuffer(1, 1, 44100); // Bug #5: Safari does not support copyFromChannel() and copyToChannel().

        if (nativeAudioBuffer.copyToChannel === undefined) {
          return true;
        }

        const source = new Float32Array(2);

        try {
          nativeAudioBuffer.copyFromChannel(source, 0, 0);
        } catch {
          return false;
        }

        return true;
      };
    };

    const createTestAudioBufferSourceNodeStartMethodConsecutiveCallsSupport = createNativeAudioNode => {
      return nativeContext => {
        const nativeAudioBufferSourceNode = createNativeAudioNode(nativeContext, ntvCntxt => ntvCntxt.createBufferSource());
        nativeAudioBufferSourceNode.start();

        try {
          nativeAudioBufferSourceNode.start();
        } catch {
          return true;
        }

        return false;
      };
    };

    // Bug #92: Edge does not respect the duration parameter yet.
    const createTestAudioBufferSourceNodeStartMethodDurationParameterSupport = nativeOfflineAudioContextConstructor => {
      return () => {
        if (nativeOfflineAudioContextConstructor === null) {
          return Promise.resolve(false);
        }

        const offlineAudioContext = new nativeOfflineAudioContextConstructor(1, 1, 44100);
        const audioBuffer = offlineAudioContext.createBuffer(1, 1, offlineAudioContext.sampleRate);
        const audioBufferSourceNode = offlineAudioContext.createBufferSource();
        audioBuffer.getChannelData(0)[0] = 1;
        audioBufferSourceNode.buffer = audioBuffer;
        audioBufferSourceNode.start(0, 0, 0);
        audioBufferSourceNode.connect(offlineAudioContext.destination); // Bug #21: Safari does not support promises yet.

        return new Promise(resolve => {
          offlineAudioContext.oncomplete = ({
            renderedBuffer
          }) => {
            // Bug #5: Safari does not support copyFromChannel().
            resolve(renderedBuffer.getChannelData(0)[0] === 0);
          };

          offlineAudioContext.startRendering();
        });
      };
    };

    const createTestAudioBufferSourceNodeStartMethodOffsetClampingSupport = createNativeAudioNode => {
      return nativeContext => {
        const nativeAudioBufferSourceNode = createNativeAudioNode(nativeContext, ntvCntxt => ntvCntxt.createBufferSource());
        const nativeAudioBuffer = nativeContext.createBuffer(1, 1, 44100);
        nativeAudioBufferSourceNode.buffer = nativeAudioBuffer;

        try {
          nativeAudioBufferSourceNode.start(0, 1);
        } catch {
          return false;
        }

        return true;
      };
    };

    const createTestAudioBufferSourceNodeStopMethodNullifiedBufferSupport = createNativeAudioNode => {
      return nativeContext => {
        const nativeAudioBufferSourceNode = createNativeAudioNode(nativeContext, ntvCntxt => ntvCntxt.createBufferSource());
        nativeAudioBufferSourceNode.start();

        try {
          nativeAudioBufferSourceNode.stop();
        } catch {
          return false;
        }

        return true;
      };
    };

    const createTestAudioContextCloseMethodSupport = nativeAudioContextConstructor => {
      return () => {
        if (nativeAudioContextConstructor === null) {
          return false;
        } // Try to check the prototype before constructing the AudioContext.


        if (nativeAudioContextConstructor.prototype !== undefined && nativeAudioContextConstructor.prototype.close !== undefined) {
          return true;
        }

        const audioContext = new nativeAudioContextConstructor();
        const isAudioContextClosable = audioContext.close !== undefined;

        try {
          audioContext.close();
        } catch {// Ignore errors.
        }

        return isAudioContextClosable;
      };
    };

    /**
     * Edge up to version 14, Firefox up to version 52, Safari up to version 9 and maybe other browsers
     * did not refuse to decode invalid parameters with a TypeError.
     */
    const createTestAudioContextDecodeAudioDataMethodTypeErrorSupport = nativeOfflineAudioContextConstructor => {
      return () => {
        if (nativeOfflineAudioContextConstructor === null) {
          return Promise.resolve(false);
        }

        const offlineAudioContext = new nativeOfflineAudioContextConstructor(1, 1, 44100); // Bug #21: Safari does not support promises yet.

        return new Promise(resolve => {
          let isPending = true;

          const resolvePromise = err => {
            if (isPending) {
              isPending = false;
              offlineAudioContext.startRendering();
              resolve(err instanceof TypeError);
            }
          };

          let promise; // Bug #26: Safari throws a synchronous error.

          try {
            promise = offlineAudioContext // Bug #1: Safari requires a successCallback.
            .decodeAudioData(null, () => {// Ignore the success callback.
            }, resolvePromise);
          } catch (err) {
            resolvePromise(err);
          } // Bug #21: Safari does not support promises yet.


          if (promise !== undefined) {
            // Bug #6 Chrome does not call the errorCallback
            promise.catch(resolvePromise);
          }
        });
      };
    };

    const createTestAudioContextOptionsSupport = nativeAudioContextConstructor => {
      return () => {
        if (nativeAudioContextConstructor === null) {
          return false;
        }

        let audioContext;

        try {
          audioContext = new nativeAudioContextConstructor({
            latencyHint: 'balanced'
          });
        } catch {
          return false;
        }

        audioContext.close();
        return true;
      };
    };

    // Safari up to version 12.0 (but not v12.1) didn't return the destination in case it was an AudioNode.
    const createTestAudioNodeConnectMethodSupport = nativeOfflineAudioContextConstructor => {
      return () => {
        if (nativeOfflineAudioContextConstructor === null) {
          return false;
        }

        const nativeOfflineAudioContext = new nativeOfflineAudioContextConstructor(1, 1, 44100);
        const nativeGainNode = nativeOfflineAudioContext.createGain();
        const isSupported = nativeGainNode.connect(nativeGainNode) === nativeGainNode;
        nativeGainNode.disconnect(nativeGainNode);
        return isSupported;
      };
    };

    const createTestAudioScheduledSourceNodeStartMethodNegativeParametersSupport = createNativeAudioNode => {
      return nativeContext => {
        const nativeAudioBufferSourceNode = createNativeAudioNode(nativeContext, ntvCntxt => ntvCntxt.createOscillator());

        try {
          nativeAudioBufferSourceNode.start(-1);
        } catch (err) {
          return err instanceof RangeError;
        }

        return false;
      };
    };

    const createTestAudioScheduledSourceNodeStopMethodConsecutiveCallsSupport = createNativeAudioNode => {
      return nativeContext => {
        const nativeAudioBuffer = nativeContext.createBuffer(1, 1, 44100);
        const nativeAudioBufferSourceNode = createNativeAudioNode(nativeContext, ntvCntxt => ntvCntxt.createBufferSource());
        nativeAudioBufferSourceNode.buffer = nativeAudioBuffer;
        nativeAudioBufferSourceNode.start();
        nativeAudioBufferSourceNode.stop();

        try {
          nativeAudioBufferSourceNode.stop();
          return true;
        } catch {
          return false;
        }
      };
    };

    const createTestAudioScheduledSourceNodeStopMethodNegativeParametersSupport = createNativeAudioNode => {
      return nativeContext => {
        const nativeAudioBufferSourceNode = createNativeAudioNode(nativeContext, ntvCntxt => ntvCntxt.createOscillator());

        try {
          nativeAudioBufferSourceNode.stop(-1);
        } catch (err) {
          return err instanceof RangeError;
        }

        return false;
      };
    };

    /**
     * Chrome version 66 and 67 did not call the process() function of an AudioWorkletProcessor if it had no outputs. AudioWorklet support was
     * enabled by default in version 66.
     */
    const createTestAudioWorkletProcessorNoOutputsSupport = (nativeAudioWorkletNodeConstructor, nativeOfflineAudioContextConstructor) => {
      return async () => {
        // Bug #61: If there is no native AudioWorkletNode it gets faked and therefore it is no problem if the it doesn't exist.
        if (nativeAudioWorkletNodeConstructor === null) {
          return true;
        }

        if (nativeOfflineAudioContextConstructor === null) {
          return false;
        }

        const blob = new Blob(['class A extends AudioWorkletProcessor{process(){this.port.postMessage(0)}}registerProcessor("a",A)'], {
          type: 'application/javascript; charset=utf-8'
        });
        const offlineAudioContext = new nativeOfflineAudioContextConstructor(1, 128, 3200);
        const url = URL.createObjectURL(blob);
        let isCallingProcess = false;

        try {
          await offlineAudioContext.audioWorklet.addModule(url);
          const gainNode = offlineAudioContext.createGain();
          const audioWorkletNode = new nativeAudioWorkletNodeConstructor(offlineAudioContext, 'a', {
            numberOfOutputs: 0
          });

          audioWorkletNode.port.onmessage = () => isCallingProcess = true;

          gainNode.connect(audioWorkletNode);
          await offlineAudioContext.startRendering();
        } catch {// Ignore errors.
        } finally {
          URL.revokeObjectURL(url);
        }

        return isCallingProcess;
      };
    };

    /**
     * Firefox up to version 69 did not throw an error when setting a different channelCount or channelCountMode.
     */
    const createTestChannelMergerNodeChannelCountSupport = (createNativeAudioNode, nativeOfflineAudioContextConstructor) => {
      return () => {
        if (nativeOfflineAudioContextConstructor === null) {
          return false;
        }

        const offlineAudioContext = new nativeOfflineAudioContextConstructor(1, 1, 44100);
        const nativeChannelMergerNode = createNativeAudioNode(offlineAudioContext, ntvCntxt => ntvCntxt.createChannelMerger());
        /**
         * Bug #15: Safari does not return the default properties. It still needs to be patched. This test is supposed to test the support
         * in other browsers.
         */

        if (nativeChannelMergerNode.channelCountMode === 'max') {
          return true;
        }

        try {
          nativeChannelMergerNode.channelCount = 2;
        } catch {
          return true;
        }

        return false;
      };
    };

    const createTestConstantSourceNodeAccurateSchedulingSupport = (createNativeAudioNode, nativeOfflineAudioContextConstructor) => {
      return () => {
        if (nativeOfflineAudioContextConstructor === null) {
          return false;
        }

        const nativeOfflineAudioContext = new nativeOfflineAudioContextConstructor(1, 1, 44100); // Bug #62: Edge & Safari do not support ConstantSourceNodes.

        if (nativeOfflineAudioContext.createConstantSource === undefined) {
          return true;
        }

        const nativeConstantSourceNode = createNativeAudioNode(nativeOfflineAudioContext, ntvCntxt => ntvCntxt.createConstantSource());
        /*
         * @todo This is using bug #75 to detect bug #70. That works because both bugs were unique to
         * the implementation of Firefox right now, but it could probably be done in a better way.
         */

        return nativeConstantSourceNode.offset.maxValue !== Number.POSITIVE_INFINITY;
      };
    };

    // Opera up to version 57 did not allow to reassign the buffer of a ConvolverNode.
    const createTestConvolverNodeBufferReassignabilitySupport = nativeOfflineAudioContextConstructor => {
      return () => {
        if (nativeOfflineAudioContextConstructor === null) {
          return false;
        }

        const offlineAudioContext = new nativeOfflineAudioContextConstructor(1, 1, 44100);
        const nativeConvolverNode = offlineAudioContext.createConvolver();
        nativeConvolverNode.buffer = offlineAudioContext.createBuffer(1, 1, offlineAudioContext.sampleRate);

        try {
          nativeConvolverNode.buffer = offlineAudioContext.createBuffer(1, 1, offlineAudioContext.sampleRate);
        } catch {
          return false;
        }

        return true;
      };
    };

    const createTestIsSecureContextSupport = window => {
      return () => window !== null && window.hasOwnProperty('isSecureContext');
    };

    // Firefox up to version 68 did not throw an error when creating a MediaStreamAudioSourceNode with a mediaStream that had no audio track.
    const createTestMediaStreamAudioSourceNodeMediaStreamWithoutAudioTrackSupport = nativeAudioContextConstructor => {
      return () => {
        if (nativeAudioContextConstructor === null) {
          return false;
        }

        const audioContext = new nativeAudioContextConstructor();

        try {
          audioContext.createMediaStreamSource(new MediaStream());
          return false;
        } catch (err) {
          return true;
        }
      };
    };

    const createTestOfflineAudioContextCurrentTimeSupport = (createNativeGainNode, nativeOfflineAudioContextConstructor) => {
      return () => {
        if (nativeOfflineAudioContextConstructor === null) {
          return Promise.resolve(false);
        }

        const nativeOfflineAudioContext = new nativeOfflineAudioContextConstructor(1, 1, 44100); // Bug #48: Safari does not render an OfflineAudioContext without any connected node.

        const gainNode = createNativeGainNode(nativeOfflineAudioContext, {
          channelCount: 1,
          channelCountMode: 'explicit',
          channelInterpretation: 'discrete',
          gain: 0
        }); // Bug #21: Safari does not support promises yet.

        return new Promise(resolve => {
          nativeOfflineAudioContext.oncomplete = () => {
            gainNode.disconnect();
            resolve(nativeOfflineAudioContext.currentTime !== 0);
          };

          nativeOfflineAudioContext.startRendering();
        });
      };
    };

    /**
     * Firefox up to version 62 did not kick off the processing of the StereoPannerNode if the value of pan was zero.
     */
    const createTestStereoPannerNodeDefaultValueSupport = nativeOfflineAudioContextConstructor => {
      return () => {
        if (nativeOfflineAudioContextConstructor === null) {
          return Promise.resolve(false);
        }

        const nativeOfflineAudioContext = new nativeOfflineAudioContextConstructor(1, 1, 44100);
        /*
         * Bug #105: Safari does not support the StereoPannerNode. Therefore the returned value should normally be false but the faker does
         * support the tested behaviour.
         */

        if (nativeOfflineAudioContext.createStereoPanner === undefined) {
          return Promise.resolve(true);
        } // Bug #62: Edge & Safari do not support ConstantSourceNodes.


        if (nativeOfflineAudioContext.createConstantSource === undefined) {
          return Promise.resolve(true);
        }

        const constantSourceNode = nativeOfflineAudioContext.createConstantSource();
        const stereoPanner = nativeOfflineAudioContext.createStereoPanner();
        constantSourceNode.channelCount = 1;
        constantSourceNode.offset.value = 1;
        stereoPanner.channelCount = 1;
        constantSourceNode.start();
        constantSourceNode.connect(stereoPanner).connect(nativeOfflineAudioContext.destination);
        return nativeOfflineAudioContext.startRendering().then(buffer => buffer.getChannelData(0)[0] !== 1);
      };
    };

    const createUnknownError = () => {
      try {
        return new DOMException('', 'UnknownError');
      } catch (err) {
        // Bug #122: Edge is the only browser that does not yet allow to construct a DOMException.
        err.name = 'UnknownError';
        return err;
      }
    };

    const DEFAULT_OPTIONS$k = {
      channelCount: 2,
      channelCountMode: 'max',
      channelInterpretation: 'speakers',
      curve: null,
      oversample: 'none'
    };
    const createWaveShaperNodeConstructor = (audioNodeConstructor, createInvalidStateError, createNativeWaveShaperNode, createWaveShaperNodeRenderer, getNativeContext, isNativeOfflineAudioContext) => {
      return class WaveShaperNode extends audioNodeConstructor {
        constructor(context, options = DEFAULT_OPTIONS$k) {
          const nativeContext = getNativeContext(context);
          const mergedOptions = { ...DEFAULT_OPTIONS$k,
            ...options
          };
          const nativeWaveShaperNode = createNativeWaveShaperNode(nativeContext, mergedOptions);
          const isOffline = isNativeOfflineAudioContext(nativeContext);
          const waveShaperNodeRenderer = isOffline ? createWaveShaperNodeRenderer() : null; // @todo Add a mechanism to only switch a WaveShaperNode to active while it is connected.

          super(context, true, nativeWaveShaperNode, waveShaperNodeRenderer);
          this._isCurveNullified = false;
          this._nativeWaveShaperNode = nativeWaveShaperNode;
        }

        get curve() {
          if (this._isCurveNullified) {
            return null;
          }

          return this._nativeWaveShaperNode.curve;
        }

        set curve(value) {
          // Bug #103: Safari does not allow to set the curve to null.
          if (value === null) {
            this._isCurveNullified = true;
            this._nativeWaveShaperNode.curve = new Float32Array([0, 0]);
          } else {
            // Bug #102: Safari does not throw an InvalidStateError when the curve has less than two samples.
            // Bug #104: Chrome will throw an InvalidAccessError when the curve has less than two samples.
            if (value.length < 2) {
              throw createInvalidStateError();
            }

            this._isCurveNullified = false;
            this._nativeWaveShaperNode.curve = value;
          }
        }

        get oversample() {
          return this._nativeWaveShaperNode.oversample;
        }

        set oversample(value) {
          this._nativeWaveShaperNode.oversample = value;
        }

      };
    };

    const createWaveShaperNodeRendererFactory = (createNativeWaveShaperNode, getNativeAudioNode, renderInputsOfAudioNode) => {
      return () => {
        const renderedNativeWaveShaperNodes = new WeakMap();

        const createWaveShaperNode = async (proxy, nativeOfflineAudioContext, trace) => {
          let nativeWaveShaperNode = getNativeAudioNode(proxy); // If the initially used nativeWaveShaperNode was not constructed on the same OfflineAudioContext it needs to be created again.

          const nativeWaveShaperNodeIsOwnedByContext = isOwnedByContext(nativeWaveShaperNode, nativeOfflineAudioContext);

          if (!nativeWaveShaperNodeIsOwnedByContext) {
            const options = {
              channelCount: nativeWaveShaperNode.channelCount,
              channelCountMode: nativeWaveShaperNode.channelCountMode,
              channelInterpretation: nativeWaveShaperNode.channelInterpretation,
              curve: nativeWaveShaperNode.curve,
              oversample: nativeWaveShaperNode.oversample
            };
            nativeWaveShaperNode = createNativeWaveShaperNode(nativeOfflineAudioContext, options);
          }

          renderedNativeWaveShaperNodes.set(nativeOfflineAudioContext, nativeWaveShaperNode);

          if (isNativeAudioNodeFaker(nativeWaveShaperNode)) {
            await renderInputsOfAudioNode(proxy, nativeOfflineAudioContext, nativeWaveShaperNode.inputs[0], trace);
          } else {
            await renderInputsOfAudioNode(proxy, nativeOfflineAudioContext, nativeWaveShaperNode, trace);
          }

          return nativeWaveShaperNode;
        };

        return {
          render(proxy, nativeOfflineAudioContext, trace) {
            const renderedNativeWaveShaperNode = renderedNativeWaveShaperNodes.get(nativeOfflineAudioContext);

            if (renderedNativeWaveShaperNode !== undefined) {
              return Promise.resolve(renderedNativeWaveShaperNode);
            }

            return createWaveShaperNode(proxy, nativeOfflineAudioContext, trace);
          }

        };
      };
    };

    const createWindow = () => typeof window === 'undefined' ? null : window;

    const createWrapAudioBufferCopyChannelMethods = (convertNumberToUnsignedLong, createIndexSizeError) => {
      return audioBuffer => {
        audioBuffer.copyFromChannel = (destination, channelNumberAsNumber, bufferOffsetAsNumber = 0) => {
          const bufferOffset = convertNumberToUnsignedLong(bufferOffsetAsNumber);
          const channelNumber = convertNumberToUnsignedLong(channelNumberAsNumber);

          if (channelNumber >= audioBuffer.numberOfChannels) {
            throw createIndexSizeError();
          }

          const audioBufferLength = audioBuffer.length;
          const channelData = audioBuffer.getChannelData(channelNumber);
          const destinationLength = destination.length;

          for (let i = bufferOffset < 0 ? -bufferOffset : 0; i + bufferOffset < audioBufferLength && i < destinationLength; i += 1) {
            destination[i] = channelData[i + bufferOffset];
          }
        };

        audioBuffer.copyToChannel = (source, channelNumberAsNumber, bufferOffsetAsNumber = 0) => {
          const bufferOffset = convertNumberToUnsignedLong(bufferOffsetAsNumber);
          const channelNumber = convertNumberToUnsignedLong(channelNumberAsNumber);

          if (channelNumber >= audioBuffer.numberOfChannels) {
            throw createIndexSizeError();
          }

          const audioBufferLength = audioBuffer.length;
          const channelData = audioBuffer.getChannelData(channelNumber);
          const sourceLength = source.length;

          for (let i = bufferOffset < 0 ? -bufferOffset : 0; i + bufferOffset < audioBufferLength && i < sourceLength; i += 1) {
            channelData[i + bufferOffset] = source[i];
          }
        };
      };
    };

    const createWrapAudioBufferCopyChannelMethodsOutOfBounds = convertNumberToUnsignedLong => {
      return audioBuffer => {
        audioBuffer.copyFromChannel = (copyFromChannel => {
          return (destination, channelNumberAsNumber, bufferOffsetAsNumber = 0) => {
            const bufferOffset = convertNumberToUnsignedLong(bufferOffsetAsNumber);
            const channelNumber = convertNumberToUnsignedLong(channelNumberAsNumber);

            if (bufferOffset < audioBuffer.length) {
              return copyFromChannel.call(audioBuffer, destination, channelNumber, bufferOffset);
            }
          };
        })(audioBuffer.copyFromChannel);

        audioBuffer.copyToChannel = (copyToChannel => {
          return (source, channelNumberAsNumber, bufferOffsetAsNumber = 0) => {
            const bufferOffset = convertNumberToUnsignedLong(bufferOffsetAsNumber);
            const channelNumber = convertNumberToUnsignedLong(channelNumberAsNumber);

            if (bufferOffset < audioBuffer.length) {
              return copyToChannel.call(audioBuffer, source, channelNumber, bufferOffset);
            }
          };
        })(audioBuffer.copyToChannel);
      };
    };

    const createWrapAudioBufferSourceNodeStopMethodNullifiedBuffer = overwriteAccessors => {
      return (nativeAudioBufferSourceNode, nativeContext) => {
        const nullifiedBuffer = nativeContext.createBuffer(1, 1, nativeContext.sampleRate);

        if (nativeAudioBufferSourceNode.buffer === null) {
          nativeAudioBufferSourceNode.buffer = nullifiedBuffer;
        }

        overwriteAccessors(nativeAudioBufferSourceNode, 'buffer', get => () => {
          const value = get.call(nativeAudioBufferSourceNode);
          return value === nullifiedBuffer ? null : value;
        }, set => value => {
          return set.call(nativeAudioBufferSourceNode, value === null ? nullifiedBuffer : value);
        });
      };
    };

    const createWrapAudioScheduledSourceNodeStopMethodConsecutiveCalls = createNativeAudioNode => {
      return (nativeAudioScheduledSourceNode, nativeContext) => {
        const nativeGainNode = createNativeAudioNode(nativeContext, ntvCntxt => ntvCntxt.createGain());
        nativeAudioScheduledSourceNode.connect(nativeGainNode);

        const disconnectGainNode = (disconnect => {
          return () => {
            // @todo TypeScript cannot infer the overloaded signature with 1 argument yet.
            disconnect.call(nativeAudioScheduledSourceNode, nativeGainNode);
            nativeAudioScheduledSourceNode.removeEventListener('ended', disconnectGainNode);
          };
        })(nativeAudioScheduledSourceNode.disconnect);

        nativeAudioScheduledSourceNode.addEventListener('ended', disconnectGainNode);
        interceptConnections(nativeAudioScheduledSourceNode, nativeGainNode);

        nativeAudioScheduledSourceNode.stop = (stop => {
          let isStopped = false;
          return (when = 0) => {
            if (isStopped) {
              try {
                stop.call(nativeAudioScheduledSourceNode, when);
              } catch {
                nativeGainNode.gain.setValueAtTime(0, when);
              }
            } else {
              stop.call(nativeAudioScheduledSourceNode, when);
              isStopped = true;
            }
          };
        })(nativeAudioScheduledSourceNode.stop);
      };
    };

    const createWrapChannelMergerNode = (createInvalidStateError, createNativeAudioNode, monitorConnectionsFunction) => {
      return (nativeContext, channelMergerNode) => {
        channelMergerNode.channelCount = 1;
        channelMergerNode.channelCountMode = 'explicit';
        Object.defineProperty(channelMergerNode, 'channelCount', {
          get: () => 1,
          set: () => {
            throw createInvalidStateError();
          }
        });
        Object.defineProperty(channelMergerNode, 'channelCountMode', {
          get: () => 'explicit',
          set: () => {
            throw createInvalidStateError();
          }
        }); // Bug #20: Safari requires a connection of any kind to treat the input signal correctly.

        const audioBufferSourceNode = createNativeAudioNode(nativeContext, ntvCntxt => ntvCntxt.createBufferSource());

        const whenConnected = () => {
          const length = channelMergerNode.numberOfInputs;

          for (let i = 0; i < length; i += 1) {
            audioBufferSourceNode.connect(channelMergerNode, 0, i);
          }
        };

        const whenDisconnected = () => audioBufferSourceNode.disconnect(channelMergerNode);

        monitorConnectionsFunction(channelMergerNode, whenConnected, whenDisconnected);
      };
    };

    const isDCCurve = curve => {
      if (curve === null) {
        return false;
      }

      const length = curve.length;

      if (length % 2 !== 0) {
        return curve[Math.floor(length / 2)] !== 0;
      }

      return curve[length / 2 - 1] + curve[length / 2] !== 0;
    };

    const overwriteAccessors = (object, property, createGetter, createSetter) => {
      let prototype = Object.getPrototypeOf(object);

      while (!prototype.hasOwnProperty(property)) {
        prototype = Object.getPrototypeOf(prototype);
      }

      const {
        get,
        set
      } = Object.getOwnPropertyDescriptor(prototype, property);
      Object.defineProperty(object, property, {
        get: createGetter(get),
        set: createSetter(set)
      });
    };

    // Safari at version 11 did not support transferables.
    const testTransferablesSupport = () => new Promise(resolve => {
      const arrayBuffer = new ArrayBuffer(0);
      const {
        port1,
        port2
      } = new MessageChannel();

      port1.onmessage = ({
        data
      }) => resolve(data !== null);

      port2.postMessage(arrayBuffer, [arrayBuffer]);
    });

    const wrapAudioBufferSourceNodeStartMethodOffsetClamping = nativeAudioBufferSourceNode => {
      nativeAudioBufferSourceNode.start = (start => {
        return (when = 0, offset = 0, duration) => {
          const buffer = nativeAudioBufferSourceNode.buffer; // Bug #154: Safari does not clamp the offset if it is equal to or greater than the duration of the buffer.

          const clampedOffset = buffer === null ? offset : Math.min(buffer.duration, offset); // Bug #155: Safari does not handle the offset correctly if it would cause the buffer to be not be played at all.

          if (buffer !== null && clampedOffset > buffer.duration - 0.5 / nativeAudioBufferSourceNode.context.sampleRate) {
            start.call(nativeAudioBufferSourceNode, when, 0, 0);
          } else {
            start.call(nativeAudioBufferSourceNode, when, clampedOffset, duration);
          }
        };
      })(nativeAudioBufferSourceNode.start);
    };

    const wrapEventListener = (target, eventListener) => {
      return event => {
        const descriptor = {
          value: target
        };
        Object.defineProperties(event, {
          currentTarget: descriptor,
          target: descriptor
        });

        if (typeof eventListener === 'function') {
          return eventListener.call(target, event);
        }

        return eventListener.handleEvent.call(target, event);
      };
    };

    const cacheTestResult = createCacheTestResult(new Map(), new WeakMap());
    const window$1 = createWindow();
    const nativeOfflineAudioContextConstructor = createNativeOfflineAudioContextConstructor(window$1);
    const isNativeOfflineAudioContext = createIsNativeOfflineAudioContext(nativeOfflineAudioContextConstructor);
    const nativeAudioContextConstructor = createNativeAudioContextConstructor(window$1);
    const getBackupNativeContext = createGetBackupNativeContext(isNativeOfflineAudioContext, nativeAudioContextConstructor, nativeOfflineAudioContextConstructor);
    const createNativeAudioNode = createNativeAudioNodeFactory(getBackupNativeContext);
    const createNativeAnalyserNode = createNativeAnalyserNodeFactory(cacheTestResult, createIndexSizeError, createNativeAudioNode);
    const getAudioNodeRenderer = createGetAudioNodeRenderer(getAudioNodeConnections);
    const renderInputsOfAudioNode = createRenderInputsOfAudioNode(getAudioNodeConnections, getAudioNodeRenderer, isPartOfACycle);
    const createAnalyserNodeRenderer = createAnalyserNodeRendererFactory(createNativeAnalyserNode, getNativeAudioNode, renderInputsOfAudioNode);
    const auxiliaryGainNodeStore = new WeakMap();
    const getNativeContext = createGetNativeContext(CONTEXT_STORE);
    const audioParamAudioNodeStore = new WeakMap();
    const eventTargetConstructor = createEventTargetConstructor(wrapEventListener);
    const isNativeAudioContext = createIsNativeAudioContext(nativeAudioContextConstructor);
    const isNativeAudioNode$1 = createIsNativeAudioNode(window$1);
    const isNativeAudioParam = createIsNativeAudioParam(window$1);
    const audioNodeConstructor = createAudioNodeConstructor(createAddAudioNodeConnections(AUDIO_NODE_CONNECTIONS_STORE), auxiliaryGainNodeStore, cacheTestResult, createIncrementCycleCounterFactory(CYCLE_COUNTERS, disconnectNativeAudioNodeFromNativeAudioNode, getAudioNodeConnections, getNativeAudioNode, getNativeAudioParam, isActiveAudioNode), createIndexSizeError, createInvalidAccessError, createNotSupportedError, createDecrementCycleCounter(connectNativeAudioNodeToNativeAudioNode, CYCLE_COUNTERS, getAudioNodeConnections, getNativeAudioNode, getNativeAudioParam, getNativeContext, isActiveAudioNode, isNativeOfflineAudioContext), createDetectCycles(audioParamAudioNodeStore, getAudioNodeConnections, getValueForKey), eventTargetConstructor, getNativeContext, isNativeAudioContext, isNativeAudioNode$1, isNativeAudioParam, isNativeOfflineAudioContext);
    const analyserNodeConstructor = createAnalyserNodeConstructor(audioNodeConstructor, createAnalyserNodeRenderer, createIndexSizeError, createNativeAnalyserNode, getNativeContext, isNativeOfflineAudioContext);
    const audioBufferStore = new WeakSet();
    const nativeAudioBufferConstructor = createNativeAudioBufferConstructor(window$1);
    const convertNumberToUnsignedLong = createConvertNumberToUnsignedLong(new Uint32Array(1));
    const wrapAudioBufferCopyChannelMethods = createWrapAudioBufferCopyChannelMethods(convertNumberToUnsignedLong, createIndexSizeError);
    const wrapAudioBufferCopyChannelMethodsOutOfBounds = createWrapAudioBufferCopyChannelMethodsOutOfBounds(convertNumberToUnsignedLong);
    const audioBufferConstructor = createAudioBufferConstructor(audioBufferStore, cacheTestResult, createNotSupportedError, nativeAudioBufferConstructor, nativeOfflineAudioContextConstructor, createTestAudioBufferConstructorSupport(nativeAudioBufferConstructor), wrapAudioBufferCopyChannelMethods, wrapAudioBufferCopyChannelMethodsOutOfBounds);
    const createNativeGainNode = createNativeGainNodeFactory(createNativeAudioNode);
    const addSilentConnection = createAddSilentConnection(createNativeGainNode);
    const testAudioScheduledSourceNodeStartMethodNegativeParametersSupport = createTestAudioScheduledSourceNodeStartMethodNegativeParametersSupport(createNativeAudioNode);
    const testAudioScheduledSourceNodeStopMethodConsecutiveCallsSupport = createTestAudioScheduledSourceNodeStopMethodConsecutiveCallsSupport(createNativeAudioNode);
    const testAudioScheduledSourceNodeStopMethodNegativeParametersSupport = createTestAudioScheduledSourceNodeStopMethodNegativeParametersSupport(createNativeAudioNode);
    const wrapAudioScheduledSourceNodeStopMethodConsecutiveCalls = createWrapAudioScheduledSourceNodeStopMethodConsecutiveCalls(createNativeAudioNode);
    const renderInputsOfAudioParam = createRenderInputsOfAudioParam(getAudioNodeRenderer, getAudioParamConnections, isPartOfACycle);
    const connectAudioParam = createConnectAudioParam(renderInputsOfAudioParam);
    const createNativeAudioBufferSourceNode = createNativeAudioBufferSourceNodeFactory(addSilentConnection, cacheTestResult, createNativeAudioNode, createTestAudioBufferSourceNodeStartMethodConsecutiveCallsSupport(createNativeAudioNode), createTestAudioBufferSourceNodeStartMethodDurationParameterSupport(nativeOfflineAudioContextConstructor), createTestAudioBufferSourceNodeStartMethodOffsetClampingSupport(createNativeAudioNode), createTestAudioBufferSourceNodeStopMethodNullifiedBufferSupport(createNativeAudioNode), testAudioScheduledSourceNodeStartMethodNegativeParametersSupport, testAudioScheduledSourceNodeStopMethodConsecutiveCallsSupport, testAudioScheduledSourceNodeStopMethodNegativeParametersSupport, wrapAudioBufferSourceNodeStartMethodOffsetClamping, createWrapAudioBufferSourceNodeStopMethodNullifiedBuffer(overwriteAccessors), wrapAudioScheduledSourceNodeStopMethodConsecutiveCalls);
    const renderAutomation = createRenderAutomation(createGetAudioParamRenderer(getAudioParamConnections), renderInputsOfAudioParam);
    const createAudioBufferSourceNodeRenderer = createAudioBufferSourceNodeRendererFactory(connectAudioParam, createNativeAudioBufferSourceNode, getNativeAudioNode, renderAutomation, renderInputsOfAudioNode);
    const createAudioParam = createAudioParamFactory(createAddAudioParamConnections(AUDIO_PARAM_CONNECTIONS_STORE), audioParamAudioNodeStore, AUDIO_PARAM_STORE, createAudioParamRenderer, automationEvents.createCancelAndHoldAutomationEvent, automationEvents.createCancelScheduledValuesAutomationEvent, automationEvents.createExponentialRampToValueAutomationEvent, automationEvents.createLinearRampToValueAutomationEvent, automationEvents.createSetTargetAutomationEvent, automationEvents.createSetValueAutomationEvent, automationEvents.createSetValueCurveAutomationEvent, nativeAudioContextConstructor);
    const audioBufferSourceNodeConstructor = createAudioBufferSourceNodeConstructor(audioNodeConstructor, createAudioBufferSourceNodeRenderer, createAudioParam, createInvalidStateError, createNativeAudioBufferSourceNode, getNativeContext, isNativeOfflineAudioContext, wrapEventListener);
    const audioDestinationNodeConstructor = createAudioDestinationNodeConstructor(audioNodeConstructor, createAudioDestinationNodeRenderer, createIndexSizeError, createInvalidStateError, createNativeAudioDestinationNodeFactory(createNativeGainNode, overwriteAccessors), getNativeContext, isNativeOfflineAudioContext, renderInputsOfAudioNode);
    const createNativeBiquadFilterNode = createNativeBiquadFilterNodeFactory(createNativeAudioNode);
    const createBiquadFilterNodeRenderer = createBiquadFilterNodeRendererFactory(connectAudioParam, createNativeBiquadFilterNode, getNativeAudioNode, renderAutomation, renderInputsOfAudioNode);
    const biquadFilterNodeConstructor = createBiquadFilterNodeConstructor(audioNodeConstructor, createAudioParam, createBiquadFilterNodeRenderer, createInvalidAccessError, createNativeBiquadFilterNode, getNativeContext, isNativeOfflineAudioContext);
    const monitorConnections = createMonitorConnections(insertElementInSet, isNativeAudioNode$1);
    const wrapChannelMergerNode = createWrapChannelMergerNode(createInvalidStateError, createNativeAudioNode, monitorConnections);
    const createNativeChannelMergerNode = createNativeChannelMergerNodeFactory(createNativeAudioNode, wrapChannelMergerNode);
    const createChannelMergerNodeRenderer = createChannelMergerNodeRendererFactory(createNativeChannelMergerNode, getNativeAudioNode, renderInputsOfAudioNode);
    const channelMergerNodeConstructor = createChannelMergerNodeConstructor(audioNodeConstructor, createChannelMergerNodeRenderer, createNativeChannelMergerNode, getNativeContext, isNativeOfflineAudioContext);
    const createNativeChannelSplitterNode = createNativeChannelSplitterNodeFactory(createNativeAudioNode);
    const createChannelSplitterNodeRenderer = createChannelSplitterNodeRendererFactory(createNativeChannelSplitterNode, getNativeAudioNode, renderInputsOfAudioNode);
    const channelSplitterNodeConstructor = createChannelSplitterNodeConstructor(audioNodeConstructor, createChannelSplitterNodeRenderer, createNativeChannelSplitterNode, getNativeContext, isNativeOfflineAudioContext);
    const createNativeConstantSourceNodeFaker = createNativeConstantSourceNodeFakerFactory(addSilentConnection, createNativeAudioBufferSourceNode, createNativeGainNode, monitorConnections);
    const createNativeConstantSourceNode = createNativeConstantSourceNodeFactory(addSilentConnection, cacheTestResult, createNativeAudioNode, createNativeConstantSourceNodeFaker, testAudioScheduledSourceNodeStartMethodNegativeParametersSupport, testAudioScheduledSourceNodeStopMethodNegativeParametersSupport);
    const createConstantSourceNodeRenderer = createConstantSourceNodeRendererFactory(connectAudioParam, createNativeConstantSourceNode, getNativeAudioNode, renderAutomation, renderInputsOfAudioNode);
    const constantSourceNodeConstructor = createConstantSourceNodeConstructor(audioNodeConstructor, createAudioParam, createConstantSourceNodeRenderer, createNativeConstantSourceNode, getNativeContext, isNativeOfflineAudioContext, wrapEventListener);
    const createNativeConvolverNodeFaker = createNativeConvolverNodeFakerFactory(createNativeAudioNode, createNativeGainNode, monitorConnections);
    const createNativeConvolverNode = createNativeConvolverNodeFactory(createNativeAudioNode, createNativeConvolverNodeFaker, createNotSupportedError, overwriteAccessors);
    const createConvolverNodeRenderer = createConvolverNodeRendererFactory(createNativeConvolverNode, getNativeAudioNode, renderInputsOfAudioNode);
    const convolverNodeConstructor = createConvolverNodeConstructor(audioNodeConstructor, createConvolverNodeRenderer, createNativeConvolverNode, getNativeContext, isNativeOfflineAudioContext);
    const createNativeDelayNode = createNativeDelayNodeFactory(createNativeAudioNode);
    const createDelayNodeRenderer = createDelayNodeRendererFactory(connectAudioParam, createNativeDelayNode, getNativeAudioNode, renderAutomation, renderInputsOfAudioNode);
    const delayNodeConstructor = createDelayNodeConstructor(audioNodeConstructor, createAudioParam, createDelayNodeRenderer, createNativeDelayNode, getNativeContext, isNativeOfflineAudioContext);
    const createNativeDynamicsCompressorNode = createNativeDynamicsCompressorNodeFactory(createNativeAudioNode, createNotSupportedError);
    const createDynamicsCompressorNodeRenderer = createDynamicsCompressorNodeRendererFactory(connectAudioParam, createNativeDynamicsCompressorNode, getNativeAudioNode, renderAutomation, renderInputsOfAudioNode);
    const dynamicsCompressorNodeConstructor = createDynamicsCompressorNodeConstructor(audioNodeConstructor, createAudioParam, createDynamicsCompressorNodeRenderer, createNativeDynamicsCompressorNode, createNotSupportedError, getNativeContext, isNativeOfflineAudioContext);
    const createGainNodeRenderer = createGainNodeRendererFactory(connectAudioParam, createNativeGainNode, getNativeAudioNode, renderAutomation, renderInputsOfAudioNode);
    const gainNodeConstructor = createGainNodeConstructor(audioNodeConstructor, createAudioParam, createGainNodeRenderer, createNativeGainNode, getNativeContext, isNativeOfflineAudioContext);
    const createNativeScriptProcessorNode = createNativeScriptProcessorNodeFactory(createNativeAudioNode);
    const createNativeIIRFilterNodeFaker = createNativeIIRFilterNodeFakerFactory(createInvalidAccessError, createInvalidStateError, createNativeScriptProcessorNode, createNotSupportedError);
    const renderNativeOfflineAudioContext = createRenderNativeOfflineAudioContext(cacheTestResult, createNativeGainNode, createNativeScriptProcessorNode, createTestOfflineAudioContextCurrentTimeSupport(createNativeGainNode, nativeOfflineAudioContextConstructor));
    const createIIRFilterNodeRenderer = createIIRFilterNodeRendererFactory(createNativeAudioBufferSourceNode, createNativeAudioNode, getNativeAudioNode, nativeOfflineAudioContextConstructor, renderInputsOfAudioNode, renderNativeOfflineAudioContext);
    const createNativeIIRFilterNode = createNativeIIRFilterNodeFactory(createNativeAudioNode, createNativeIIRFilterNodeFaker);
    const iIRFilterNodeConstructor = createIIRFilterNodeConstructor(audioNodeConstructor, createNativeIIRFilterNode, createIIRFilterNodeRenderer, getNativeContext, isNativeOfflineAudioContext);
    const createAudioListener = createAudioListenerFactory(createAudioParam, createNativeChannelMergerNode, createNativeConstantSourceNode, createNativeScriptProcessorNode, isNativeOfflineAudioContext);
    const unrenderedAudioWorkletNodeStore = new WeakMap();
    const minimalBaseAudioContextConstructor = createMinimalBaseAudioContextConstructor(audioDestinationNodeConstructor, createAudioListener, eventTargetConstructor, isNativeOfflineAudioContext, unrenderedAudioWorkletNodeStore, wrapEventListener);
    const createNativeOscillatorNode = createNativeOscillatorNodeFactory(addSilentConnection, cacheTestResult, createNativeAudioNode, testAudioScheduledSourceNodeStartMethodNegativeParametersSupport, testAudioScheduledSourceNodeStopMethodConsecutiveCallsSupport, testAudioScheduledSourceNodeStopMethodNegativeParametersSupport, wrapAudioScheduledSourceNodeStopMethodConsecutiveCalls);
    const createOscillatorNodeRenderer = createOscillatorNodeRendererFactory(connectAudioParam, createNativeOscillatorNode, getNativeAudioNode, renderAutomation, renderInputsOfAudioNode);
    const oscillatorNodeConstructor = createOscillatorNodeConstructor(audioNodeConstructor, createAudioParam, createInvalidStateError, createNativeOscillatorNode, createOscillatorNodeRenderer, getNativeContext, isNativeOfflineAudioContext, wrapEventListener);
    const createConnectedNativeAudioBufferSourceNode = createConnectedNativeAudioBufferSourceNodeFactory(createNativeAudioBufferSourceNode);
    const createNativeWaveShaperNodeFaker = createNativeWaveShaperNodeFakerFactory(createConnectedNativeAudioBufferSourceNode, createInvalidStateError, createNativeAudioNode, createNativeGainNode, isDCCurve, monitorConnections);
    const createNativeWaveShaperNode = createNativeWaveShaperNodeFactory(createConnectedNativeAudioBufferSourceNode, createInvalidStateError, createNativeAudioNode, createNativeWaveShaperNodeFaker, isDCCurve, monitorConnections, overwriteAccessors);
    const createNativePannerNodeFaker = createNativePannerNodeFakerFactory(connectNativeAudioNodeToNativeAudioNode, createInvalidStateError, createNativeAudioNode, createNativeChannelMergerNode, createNativeGainNode, createNativeScriptProcessorNode, createNativeWaveShaperNode, createNotSupportedError, disconnectNativeAudioNodeFromNativeAudioNode, monitorConnections);
    const createNativePannerNode = createNativePannerNodeFactory(createNativeAudioNode, createNativePannerNodeFaker);
    const createPannerNodeRenderer = createPannerNodeRendererFactory(connectAudioParam, createNativeChannelMergerNode, createNativeConstantSourceNode, createNativeGainNode, createNativePannerNode, getNativeAudioNode, nativeOfflineAudioContextConstructor, renderAutomation, renderInputsOfAudioNode, renderNativeOfflineAudioContext);
    const pannerNodeConstructor = createPannerNodeConstructor(audioNodeConstructor, createAudioParam, createNativePannerNode, createPannerNodeRenderer, getNativeContext, isNativeOfflineAudioContext);
    const createNativePeriodicWave = createNativePeriodicWaveFactory(getBackupNativeContext);
    const periodicWaveConstructor = createPeriodicWaveConstructor(createNativePeriodicWave, getNativeContext, new WeakSet());
    const nativeStereoPannerNodeFakerFactory = createNativeStereoPannerNodeFakerFactory(createNativeChannelMergerNode, createNativeChannelSplitterNode, createNativeGainNode, createNativeWaveShaperNode, createNotSupportedError, monitorConnections);
    const createNativeStereoPannerNode = createNativeStereoPannerNodeFactory(createNativeAudioNode, nativeStereoPannerNodeFakerFactory, createNotSupportedError);
    const createStereoPannerNodeRenderer = createStereoPannerNodeRendererFactory(connectAudioParam, createNativeStereoPannerNode, getNativeAudioNode, renderAutomation, renderInputsOfAudioNode);
    const stereoPannerNodeConstructor = createStereoPannerNodeConstructor(audioNodeConstructor, createAudioParam, createNativeStereoPannerNode, createStereoPannerNodeRenderer, getNativeContext, isNativeOfflineAudioContext);
    const createWaveShaperNodeRenderer = createWaveShaperNodeRendererFactory(createNativeWaveShaperNode, getNativeAudioNode, renderInputsOfAudioNode);
    const waveShaperNodeConstructor = createWaveShaperNodeConstructor(audioNodeConstructor, createInvalidStateError, createNativeWaveShaperNode, createWaveShaperNodeRenderer, getNativeContext, isNativeOfflineAudioContext);
    const isSecureContext = createIsSecureContext(window$1);
    const exposeCurrentFrameAndCurrentTime = createExposeCurrentFrameAndCurrentTime(window$1); // The addAudioWorkletModule() function is only available in a SecureContext.

    const addAudioWorkletModule = isSecureContext ? createAddAudioWorkletModule(createNotSupportedError, createEvaluateSource(window$1), exposeCurrentFrameAndCurrentTime, createFetchSource(createAbortError), getBackupNativeContext, getNativeContext, new WeakMap(), new WeakMap(), // @todo window is guaranteed to be defined because isSecureContext checks that as well.
    window$1) : undefined;
    const isNativeContext = createIsNativeContext(isNativeAudioContext, isNativeOfflineAudioContext);
    const decodeAudioData = createDecodeAudioData(audioBufferStore, cacheTestResult, createDataCloneError, createEncodingError, new WeakSet(), getNativeContext, isNativeContext, isNativeOfflineAudioContext, nativeOfflineAudioContextConstructor, testAudioBufferCopyChannelMethodsOutOfBoundsSupport, testPromiseSupport, wrapAudioBufferCopyChannelMethods, wrapAudioBufferCopyChannelMethodsOutOfBounds);
    const baseAudioContextConstructor = createBaseAudioContextConstructor(addAudioWorkletModule, analyserNodeConstructor, audioBufferConstructor, audioBufferSourceNodeConstructor, biquadFilterNodeConstructor, channelMergerNodeConstructor, channelSplitterNodeConstructor, constantSourceNodeConstructor, convolverNodeConstructor, decodeAudioData, delayNodeConstructor, dynamicsCompressorNodeConstructor, gainNodeConstructor, iIRFilterNodeConstructor, minimalBaseAudioContextConstructor, oscillatorNodeConstructor, pannerNodeConstructor, periodicWaveConstructor, stereoPannerNodeConstructor, waveShaperNodeConstructor);
    const createNativeMediaElementAudioSourceNode = createNativeMediaElementAudioSourceNodeFactory(createNativeAudioNode);
    const mediaElementAudioSourceNodeConstructor = createMediaElementAudioSourceNodeConstructor(audioNodeConstructor, createNativeMediaElementAudioSourceNode, getNativeContext, isNativeOfflineAudioContext);
    const createNativeMediaStreamAudioDestinationNode = createNativeMediaStreamAudioDestinationNodeFactory(createNativeAudioNode, createNotSupportedError);
    const mediaStreamAudioDestinationNodeConstructor = createMediaStreamAudioDestinationNodeConstructor(audioNodeConstructor, createNativeMediaStreamAudioDestinationNode, getNativeContext, isNativeOfflineAudioContext);
    const createNativeMediaStreamAudioSourceNode = createNativeMediaStreamAudioSourceNodeFactory(createNativeAudioNode);
    const mediaStreamAudioSourceNodeConstructor = createMediaStreamAudioSourceNodeConstructor(audioNodeConstructor, createNativeMediaStreamAudioSourceNode, getNativeContext, isNativeOfflineAudioContext);
    const createNativeMediaStreamTrackAudioSourceNode = createNativeMediaStreamTrackAudioSourceNodeFactory(createInvalidStateError, createNativeAudioNode, isNativeOfflineAudioContext);
    const mediaStreamTrackAudioSourceNodeConstructor = createMediaStreamTrackAudioSourceNodeConstructor(audioNodeConstructor, createNativeMediaStreamTrackAudioSourceNode, getNativeContext);
    const audioContextConstructor = createAudioContextConstructor(baseAudioContextConstructor, createInvalidStateError, createNotSupportedError, createUnknownError, mediaElementAudioSourceNodeConstructor, mediaStreamAudioDestinationNodeConstructor, mediaStreamAudioSourceNodeConstructor, mediaStreamTrackAudioSourceNodeConstructor, nativeAudioContextConstructor);
    const getUnrenderedAudioWorkletNodes = createGetUnrenderedAudioWorkletNodes(unrenderedAudioWorkletNodeStore);
    const addUnrenderedAudioWorkletNode = createAddUnrenderedAudioWorkletNode(getUnrenderedAudioWorkletNodes);
    const connectMultipleOutputs = createConnectMultipleOutputs(createIndexSizeError);
    const deleteUnrenderedAudioWorkletNode = createDeleteUnrenderedAudioWorkletNode(getUnrenderedAudioWorkletNodes);
    const disconnectMultipleOutputs = createDisconnectMultipleOutputs(createIndexSizeError);
    const createNativeAudioWorkletNodeFaker = createNativeAudioWorkletNodeFakerFactory(auxiliaryGainNodeStore, connectMultipleOutputs, createIndexSizeError, createInvalidStateError, createNativeChannelMergerNode, createNativeChannelSplitterNode, createNativeConstantSourceNode, createNativeGainNode, createNativeScriptProcessorNode, createNotSupportedError, disconnectMultipleOutputs, exposeCurrentFrameAndCurrentTime, monitorConnections);
    const createNativeAudioWorkletNode = createNativeAudioWorkletNodeFactory(createInvalidStateError, createNativeAudioNode, createNativeAudioWorkletNodeFaker, createNativeGainNode, createNotSupportedError, monitorConnections);
    const nativeAudioWorkletNodeConstructor = createNativeAudioWorkletNodeConstructor(window$1);
    const createAudioWorkletNodeRenderer = createAudioWorkletNodeRendererFactory(connectAudioParam, connectMultipleOutputs, createNativeAudioBufferSourceNode, createNativeChannelMergerNode, createNativeChannelSplitterNode, createNativeConstantSourceNode, createNativeGainNode, deleteUnrenderedAudioWorkletNode, disconnectMultipleOutputs, exposeCurrentFrameAndCurrentTime, getNativeAudioNode, nativeAudioWorkletNodeConstructor, nativeOfflineAudioContextConstructor, renderAutomation, renderInputsOfAudioNode, renderNativeOfflineAudioContext); // The AudioWorkletNode constructor is only available in a SecureContext.

    const audioWorkletNodeConstructor = isSecureContext ? createAudioWorkletNodeConstructor(addUnrenderedAudioWorkletNode, audioNodeConstructor, createAudioParam, createAudioWorkletNodeRenderer, createNativeAudioWorkletNode, getNativeContext, isNativeOfflineAudioContext, nativeAudioWorkletNodeConstructor, wrapEventListener) : undefined;
    const minimalAudioContextConstructor = createMinimalAudioContextConstructor(createInvalidStateError, createNotSupportedError, createUnknownError, minimalBaseAudioContextConstructor, nativeAudioContextConstructor);
    const createNativeOfflineAudioContext = createCreateNativeOfflineAudioContext(createNotSupportedError, nativeOfflineAudioContextConstructor);
    const startRendering = createStartRendering(audioBufferStore, cacheTestResult, getAudioNodeRenderer, getUnrenderedAudioWorkletNodes, renderNativeOfflineAudioContext, testAudioBufferCopyChannelMethodsOutOfBoundsSupport, wrapAudioBufferCopyChannelMethods, wrapAudioBufferCopyChannelMethodsOutOfBounds);
    const minimalOfflineAudioContextConstructor = createMinimalOfflineAudioContextConstructor(cacheTestResult, createInvalidStateError, createNativeOfflineAudioContext, minimalBaseAudioContextConstructor, startRendering);
    const offlineAudioContextConstructor = createOfflineAudioContextConstructor(baseAudioContextConstructor, cacheTestResult, createInvalidStateError, createNativeOfflineAudioContext, startRendering);
    const isAnyAudioContext = createIsAnyAudioContext(CONTEXT_STORE, isNativeAudioContext);
    const isAnyAudioNode = createIsAnyAudioNode(AUDIO_NODE_STORE, isNativeAudioNode$1);
    const isAnyAudioParam = createIsAnyAudioParam(AUDIO_PARAM_STORE, isNativeAudioParam);
    const isAnyOfflineAudioContext = createIsAnyOfflineAudioContext(CONTEXT_STORE, isNativeOfflineAudioContext);
    const isSupported = () => createIsSupportedPromise(cacheTestResult, createTestAudioBufferCopyChannelMethodsSubarraySupport(nativeOfflineAudioContextConstructor), createTestAudioContextCloseMethodSupport(nativeAudioContextConstructor), createTestAudioContextDecodeAudioDataMethodTypeErrorSupport(nativeOfflineAudioContextConstructor), createTestAudioContextOptionsSupport(nativeAudioContextConstructor), createTestAudioNodeConnectMethodSupport(nativeOfflineAudioContextConstructor), createTestAudioWorkletProcessorNoOutputsSupport(nativeAudioWorkletNodeConstructor, nativeOfflineAudioContextConstructor), createTestChannelMergerNodeChannelCountSupport(createNativeAudioNode, nativeOfflineAudioContextConstructor), createTestConstantSourceNodeAccurateSchedulingSupport(createNativeAudioNode, nativeOfflineAudioContextConstructor), createTestConvolverNodeBufferReassignabilitySupport(nativeOfflineAudioContextConstructor), createTestIsSecureContextSupport(window$1), createTestMediaStreamAudioSourceNodeMediaStreamWithoutAudioTrackSupport(nativeAudioContextConstructor), createTestStereoPannerNodeDefaultValueSupport(nativeOfflineAudioContextConstructor), testTransferablesSupport);

    exports.AnalyserNode = analyserNodeConstructor;
    exports.AudioBuffer = audioBufferConstructor;
    exports.AudioBufferSourceNode = audioBufferSourceNodeConstructor;
    exports.AudioContext = audioContextConstructor;
    exports.AudioWorkletNode = audioWorkletNodeConstructor;
    exports.BiquadFilterNode = biquadFilterNodeConstructor;
    exports.ChannelMergerNode = channelMergerNodeConstructor;
    exports.ChannelSplitterNode = channelSplitterNodeConstructor;
    exports.ConstantSourceNode = constantSourceNodeConstructor;
    exports.ConvolverNode = convolverNodeConstructor;
    exports.DelayNode = delayNodeConstructor;
    exports.DynamicsCompressorNode = dynamicsCompressorNodeConstructor;
    exports.GainNode = gainNodeConstructor;
    exports.IIRFilterNode = iIRFilterNodeConstructor;
    exports.MediaElementAudioSourceNode = mediaElementAudioSourceNodeConstructor;
    exports.MediaStreamAudioDestinationNode = mediaStreamAudioDestinationNodeConstructor;
    exports.MediaStreamAudioSourceNode = mediaStreamAudioSourceNodeConstructor;
    exports.MediaStreamTrackAudioSourceNode = mediaStreamTrackAudioSourceNodeConstructor;
    exports.MinimalAudioContext = minimalAudioContextConstructor;
    exports.MinimalOfflineAudioContext = minimalOfflineAudioContextConstructor;
    exports.OfflineAudioContext = offlineAudioContextConstructor;
    exports.OscillatorNode = oscillatorNodeConstructor;
    exports.PannerNode = pannerNodeConstructor;
    exports.PeriodicWave = periodicWaveConstructor;
    exports.StereoPannerNode = stereoPannerNodeConstructor;
    exports.WaveShaperNode = waveShaperNodeConstructor;
    exports.addAudioWorkletModule = addAudioWorkletModule;
    exports.decodeAudioData = decodeAudioData;
    exports.isAnyAudioContext = isAnyAudioContext;
    exports.isAnyAudioNode = isAnyAudioNode;
    exports.isAnyAudioParam = isAnyAudioParam;
    exports.isAnyOfflineAudioContext = isAnyOfflineAudioContext;
    exports.isSupported = isSupported;

    Object.defineProperty(exports, '__esModule', { value: true });

})));
