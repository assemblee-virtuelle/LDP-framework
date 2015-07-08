/* global Function:false */
'use strict';

require('jquery');
var Handlebars = require('handlebars');
require('rdf-ext');
require('jsonld');

var JsonLdUtils = {};
JsonLdUtils.funcTemplate = function (func) {
    return function (argument1, argument2) {
        return new Promise(function (resolve, reject) {
            if (argument2 === undefined) {
                func(argument1, function (error, result) {
                    if (error != null) {
                        reject();
                    } else {
                        resolve(result);
                    }
                });
            } else {
                func(argument1, argument2, function (error, result) {
                    if (error != null) {
                        reject();
                    } else {
                        resolve(result);
                    }
                });
            }
        });
    };
};


JsonLdUtils.compact = JsonLdUtils.funcTemplate(jsonld.compact);
JsonLdUtils.expand = JsonLdUtils.funcTemplate(jsonld.expand);
JsonLdUtils.flatten = JsonLdUtils.funcTemplate(jsonld.flatten);
JsonLdUtils.frame = JsonLdUtils.funcTemplate(jsonld.frame);
JsonLdUtils.objectify = JsonLdUtils.funcTemplate(jsonld.objectify);
JsonLdUtils.normalize = JsonLdUtils.funcTemplate(jsonld.normalize);
JsonLdUtils.toRDF = JsonLdUtils.funcTemplate(jsonld.toRDF);
JsonLdUtils.fromRDF = JsonLdUtils.funcTemplate(jsonld.fromRDF);


/**
 * RESTful interface to a RDF-Ext Store using JSON-LD and Promises
 *
 * @param {rdf.Store} store
 * @param {Object} [options]
 * @constructor
 */
window.MyStore = function (options) {
    this.etags          = {};
    options             = options || {};
    this.container      = options.container;
    this.context        = options.context;
    if('template' in options) this.mainTemplate   = Handlebars.compile(options.template);
    if('partials' in options)
        for(var partialName in options.partials)
            Handlebars.registerPartial(partialName, options.partials[partialName]);
    
    var storeOptions = {};
    if ('corsProxy' in options) {
        storeOptions.request = rdf.corsProxyRequest.bind(rdf, options.corsProxy)
    }
    var store = options.store ||  new rdf.promise.Store(new rdf.LdpStore(storeOptions));

    var
        parser = new rdf.promise.Parser(new rdf.JsonLdParser()),
        serializer = new rdf.promise.Serializer(new rdf.JsonLdSerializer()),
        routedContexts = {};

    // returns the document part of an hash IRI
    var documentIri = function (iri) {
        return iri.split('#', 2)[0];
    };

    // parse iri + object arguments
    var parseIriObjectsArgs = function (args) {
        if (typeof args[0] === 'string') {
            return {
                'iri': args[0],
                'objects': Array.prototype.slice.call(args).slice(1)
            };
        }

        return {
            'iri': '@id' in args[0] ? args[0]['@id'] : null,
            'objects': Array.prototype.slice.call(args).slice()
        };
    };

    // merges multiple JSON-LD objects into a single graph
    var objectsToGraph = function (iri, objects) {
        var
            graph = rdf.createGraph(),
            parseAll = [];

        var addToGraph = function (subGraph) {
            graph.addAll(subGraph);
        };

        objects.forEach(function (object) {
            // use context routing of no context is defined
            if (!('@context' in object)) {
                object = JSON.parse(JSON.stringify(object));
                object['@context'] = findContext(iri);
            }

            // use IRI if no id is defined
            if (!('@id' in object)) {
                object['@id'] = iri;
            }

            parseAll.push(parser.parse(object, iri).then(addToGraph));
        });

        return Promise.all(parseAll)
            .then(function () { return graph; });
    };

    // find a routing based context
    var findContext = function (iri) {
        for (var key in routedContexts) {
            var route = routedContexts[key];

            if ('startsWith' in route && iri.indexOf(route.startsWith) === 0) {
                return route.context;
            }

            if ('regexp' in route && route.regexp.test(iri)) {
                return route.context;
            }
        }

        return {};
    };

    /**
     * Fetches a JSON-LD object of the given IRI
     * If no context is given, it will try to get the context via routing,
     *
     * @param {String} iri IRI of the named graph
     * @param {Object} [context] JSON-LD context to compact the graph
     * @returns {Promise}
     */
    this.get = function get(object, context) {
        var iri;
        if (typeof object === 'string') {
                iri = object;
        } else {
                iri = object['@id'];
        }
        if (context == null) {
            context = findContext(iri);
        }

        return store.graph(documentIri(iri), {'useEtag': true})
            .then(function(graph) {this.etags[iri]=graph.etag;return serializer.serialize(graph)}.bind(this))
            .then(function (expanded) { return JsonLdUtils.frame(expanded, {}); })
            .then(function (framed) {
                var frame = framed['@graph'].reduce(function (p, c) { return (c['@id'] == iri ? c : p); }, {});
                return JsonLdUtils.compact(frame, context);
            });
    };

    //TODO: find out why ids get messed up
    this.resetId = function resetId(o) {
        if(o.id) {
            o['@id'] = o.id;
            delete o.id;
        }
        return o;
    }

    this.save = function save(object) {
        this.resetId(object);
        if(!('@context' in object))
            object['@context'] = this.context;
        
        if('@id' in object)
            this.put(object);
        else
            this.add(this.container, object);
    }
    
    this.list = function list(containerIri) {
        return this.get(containerIri).then(function(container) {
            var objectList = container['http://www.w3.org/ns/ldp#contains'] || [];
            if('@id' in objectList)
                objectList = [objectList];
            return objectList;
        });
    }
    
    this.move = function move(containerId) {
        this.list(containerId).then(function(objects) {
            objects.forEach(function(object) {
                this.get(object, context).then(function(object) {
                    delete object.id;
                    store.save(object);
                });
            }.bind(this));
        }.bind(this));
    }
    
    this.render = function render(div, containerIri, template, context) {
        var container = containerIri || this.container;
        var template = template || this.mainTemplate;
        var context = context || this.context;
        var objects = [];
        $(div).html(template({objects: objects}));
        
        this.list(container).then(function(objectlist) {
            objectlist.forEach(function(object) {
                this.get(object, context).then(function(object){
                    objects.push(object);
                    $(div).html(template({objects: objects}));
                });
            }.bind(this));
        }.bind(this));
    }
    
    /**
     * Adds one or more JSON-LD objects to the given IRI
     *
     * @param {String} iri IRI of the named graph
     * @param {Object} objects one or more JSON-LD objects to add
     * @returns {Promise}
     */
    this.add = function () {
        var param = parseIriObjectsArgs(arguments);
        
        return objectsToGraph("", param.objects)
            .then(function (graph) { graph.etag=this.etags[param.iri];return store.add(documentIri(param.iri), graph, {'useEtag': true, 'method': 'POST'}); }.bind(this))
            .then(function (added, error) {
                return new Promise(function (resolve, reject) {
                    if (error != null) {
                        return reject(error);
                    }

                    if (added.toArray().length === 0) {
                        return reject('no triples added');
                    }

                    resolve();
                });
            });
    };        
    /**
     * Adds one or more JSON-LD objects to the given IRI
     *
     * @param {String} iri IRI of the named graph
     * @param {Object} objects one or more JSON-LD objects to add
     * @returns {Promise}
     */
    this.put = function () {
        var param = parseIriObjectsArgs(arguments);
        
        return objectsToGraph(param.iri, param.objects)
            .then(function (graph) { graph.etag=this.etags[param.iri];return store.add(documentIri(param.iri), graph, {'useEtag': true}); }.bind(this))
            .then(function (added, error) {
                return new Promise(function (resolve, reject) {
                    if (error != null) {
                        return reject(error);
                    }

                    if (added.toArray().length === 0) {
                        return reject('no triples added');
                    }

                    resolve();
                });
            });
    };

    /**
     * Merges n JSON-LD objects to the given IRI
     *
     * @param {String} iri IRI of the named graph
     * @param {Object} objects n JSON-LD objects to merge
     * @returns {Promise}
     */
    this.patch = function () {
        var param = parseIriObjectsArgs(arguments);

        return objectsToGraph(param.iri, param.objects)
            .then(function (graph) { return store.merge(documentIri(param.iri), graph); })
            .then(function (merged, error) {
                return new Promise(function (resolve, reject) {
                    if (error != null) {
                        return reject(error);
                    }

                    if (merged.toArray().length === 0) {
                        return reject('no triples merged');
                    }

                    resolve();
                });
            });
    };

    /**
     * Deletes the content of the given IRI
     *
     * Also deletes other objects in the same document !!!
     *
     * @param {String} iri IRI of the named graph
     * @returns {Promise}
     */
    this.delete = function (iri) {
        if (typeof iri !== 'string' && '@id' in iri) {
            iri = iri['@id'];
        }

        return store.delete(documentIri(iri))
            .then(function (success, error) {
                return new Promise(function (resolve, reject) {
                    if (error != null) {
                        return reject(error);
                    }

                    if (!success) {
                        return reject();
                    }

                    resolve();
                });
            });
    };
};
