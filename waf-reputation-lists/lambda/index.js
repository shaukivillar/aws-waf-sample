#!/usr/bin/env node

/*
Copyright 2016 Amazon.com, Inc. or its affiliates. All Rights Reserved.

Licensed under the Amazon Software License (the "License"). You may not use this file except in compliance with the License. A copy of the License is located at

    http://aws.amazon.com/asl/

or in the "license" file accompanying this file. This file is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions and limitations under the License.
*/

var readline = require('readline');
var aws = require('aws-sdk');
var https = require('https');
var async = require('async');

// configure API retries
aws.config.update({
    maxRetries: 3,
    retryDelayOptions: {
        base: 1000
    }
});
var waf = new aws.WAF();

/**
 * Maximum number of IP descriptors per IP Set
 */
var maxDescriptorsPerIpSet = 1000;

/**
 * Maximum number of IP descriptors updates per call
 */
var maxDescriptorsPerIpSetUpdate = 1000;

/**
 * Convert a dotted-decimal formated address to an integer
 */
function dottedToNumber(dotted) {
    var splitted = dotted.split('.');
    return (((((Number(splitted[0]) * 256) + Number(splitted[1])) * 256) + Number(splitted[2])) * 256) + Number(splitted[3]);
}

/**
 * Convert an IPv4 address integer to dotted-decimal format
 */
function numberToDotted(number) {
    var dotted = String(number % 256);
    for (var j = 3; j > 0; j--) {
        number = Math.floor(number / 256);
        dotted = String(number % 256) + '.' + dotted;
    }
    return dotted;
}

/**
 * Constructs a new object representing an IPv4 address range
 * @class
 * @classdesc An IPv4 address range
 * @param {List} list - The List object that the range is defined in
 * @param {string|number} address - Either a number, a dotted decimal address, or a CIDR
 * @param {number} [mask] - The mask, ignored if address is CIDR
 */
function Range(list, address, mask) {
    this.list = list;
    // check to see if the address is in dotted-decimal format, optionally including the mask
    if ((typeof address == 'string') && (address.indexOf('.') !== -1)) {
        var slashPosition = address.indexOf('/');
        if (slashPosition === -1) {
            this.dotted = address;
            this.mask = 32;
        } else {
            this.dotted = address.substring(0, slashPosition);
            this.mask = Number(address.substring(slashPosition + 1));
        }
        this.number = dottedToNumber(this.dotted);
    }
    else {
        this.number = Number(address);
        this.mask = mask || 32;
        this.dotted = numberToDotted(this.number);
    }
    this.cidr = this.dotted + '/' + this.mask;
    this.lastNumber = this.number + Math.pow(2, 32 - this.mask);
}
/**
 * Test if the other range is contained within this one
 * @param {Range} other - The other range
 */
Range.prototype.contains = function (other) {
    return ((this.number <= other.number) && (this.lastNumber >= other.lastNumber));
};
Range.prototype.toString = function () {
    return this.cidr;
};

/**
 * Constructs a new object containing an URL to a reputation list
 * @class
 * @classdesc An IP Reputation List
 * @param {string} url - URL to the reputation list
 * @param {string} prefix - Regular Expression prefix before the IP address
 */
function List(url, prefix) {
    this.url = url;
    this.prefix = prefix || '';
    // a regular expression to find the address or range on each line of the list, with an option prefix before it
    this.regex = new RegExp('^' + this.prefix + '((?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])\\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])(?:/(?:3[0-2]|[1-2][0-9]|[0-9]))?)');
}
/**
 * Get ranges defined in list
 * @param {function} callback - The callback function on completion
 */
List.prototype.getRanges = function (callback) {
    var list = this;
    var ranges = [];
    https.get(this.url, function (response) {
        // create a reader object to read the list one line at a time
        var reader = readline.createInterface({ terminal: false, input: response });
        reader.on('line', function (line) {
            var result = list.regex.exec(line);
            // if there is a result, a range has been found and a new range is created
            if (result) {
                ranges.push(new Range(list, result[1]));
            }
        });
        reader.on('close', function () {
            console.log(ranges.length + ' address ranges read from ' + list.url);
            callback(null, ranges);
        });
    }).on('error', function (err) {
        console.error('Error downloading ' + this.url, err);
        callback(err);
    });
};
List.prototype.equals = function (other) {
    return this.url === other.url;
};
List.prototype.toString = function () {
    return this.url;
};

/**
 * Logs an array of ranges, with optional message, to console
 * @param {Range[]} ranges - List of ranges
 * @param {string} [message] - Message
 * @param {number} [indent=0] - Number of tabs to indent text with
 */
function logRanges(ranges, message) {
    if (message) {
        console.log(ranges.length + ' ranges ' + message);
    }
}

/**
 * Sorts an array of ranges by largest first
 * @param {Range[]} ranges - List of ranges
 */
function prioritizeRanges(ranges) {
    ranges.sort(function (a, b) {
        return a.mask - b.mask;
    });
    logRanges(ranges, 'after prioritzing');
}

/**
 * Removes ranges from a list if they are contained within other ranges
 * @param {Range[]} ranges - List of ranges
 */
function removeContainedRanges(ranges) {
    for (var i = 0; i < ranges.length; i++) {
        var range = ranges[i];
        for (var j = 0; j < ranges.length; j++) {
            var other = ranges[j];
            if (range.contains(other) && (j !== i)) {
                ranges.splice(j, 1);
                if (j < i) {
                    i--;
                }
                j--;
            }
        }
    }
    logRanges(ranges, 'after removing contained ones');
}

/**
 * Combine ranges into larger /8, /16, or /24 ranges
 * @param {Range[]} ranges - Array of ranges 
 */
function CombineRanges(ranges) {
    // TODO: should check if we can combine ranges into a larger /8, /26, /24 ranges
}

/**
 * Split ranges into smaller /8, /16, /24 or /32 ranges
 * @param {Range[]} ranges - Array of ranges 
 */
function splitRanges(ranges) {
    // AWS WAF only support ranges with /8, /16, /24 or /32 masks
    // Therefore, split ranges into ones that have the above masks
    // For example = /15 can be decomposed into 2 /16 ranges, /17 can be decomposed into 64 /14 ranges
    for (var i = 0; i < ranges.length; i++) {
        var range = ranges[i];
        var list = range.list;
        var mask = range.mask;
        var supportedMask = (mask <= 8 ? 8 : mask <= 16 ? 16 : mask <= 24 ? 24 : 32);
        var supportedMaskDifference = supportedMask - mask;
        // Check if the mask is not a /8, /16, /24 or /32
        if (supportedMaskDifference > 0) {
            var size = Math.pow(2, 32 - supportedMask);
            var count = Math.pow(2, supportedMaskDifference);
            var newRanges = [];
            // create new ranges that have /8, /16, /24 or /32 masks to replace this
            for (var j = 0; j < count; j++) {
                newRanges.push(new Range(list, range.number + (j * size), supportedMask));
            }
            // Insert the new ranges into the array, removing this one
            Array.prototype.splice.apply(ranges, [i, 1].concat(newRanges));
            // move the pointer to after the newly-inserted ranges
            i += newRanges.length - 1;
        }
    }
    logRanges(ranges, 'after splitting to /8, /16, /24 or /32 ranges...');
}

/**
 * Flattens an array of arrays into an arry
 * @param {array[]} arr - Array of arrays
 */
function flattenArrayArray(arr) {
    return arr.reduce(function (a, b) {
        return a.concat(b);
    }, []);
}

/**
 * Flattens an array of objects into an array
 * @param {array[]} arr - Array of objects
 * @param {string} propertyName - Name of property of array elements to extract 
 */
function flattenObjectArray(array, propertyName) {
    return array.map(function (o) {
        return o[propertyName];
    });
}

/**
 * Call context.done, loggin message to console
 * @param {Context} context - Lambda context object
 * @param {Error} err - Error object
 * @param {String} message - Message
 */
function done(context, err, message) {
    console[err ? 'error' : 'log'](message, err);
    context.done(err, message);
}

/**
 * Main handler
 */
exports.handler = function (event, context) {
    console.log('event: ' + JSON.stringify(event));
    if (!event || !event.lists || (event.lists.length === 0) || !event.ipSetIds || (event.ipSetIds.length === 0)) {
        done(context, null, 'Nothing to do');
    } else {
        var lists = event.lists.map(function(list) {
           return new List(list.url, list.prefix);
        });
        async.parallel([
            // download each list and parse for ranges
            function (callback) {
                async.map(lists, function (list, callback) {
                    list.getRanges(callback);
                }, function (err, ranges) {
                    if (err) {
                        console.error('Error getting ranges', err);
                    } else {
                        //ranges is an array of array of ranges, so flatten
                        ranges = flattenArrayArray(ranges);
                        console.log(ranges.length + ' ranges in total');
                        removeContainedRanges(ranges);
                        CombineRanges(ranges);
                        splitRanges(ranges);
                        prioritizeRanges(ranges);
                    }
                    callback(err, ranges);
                });
            },
            // get each waf ip set 
            function (callback) {
                async.map(event.ipSetIds, function (IPSetId, callback) {
                    waf.getIPSet({ IPSetId: IPSetId }, callback);
                }, function (err, ipSets) {
                    if (err) {
                        console.error('Error getting IP sets', err);
                    } else {
                        // ipSets is an array of objects with an IPSet property, so 'flatten' it
                        ipSets = flattenObjectArray(ipSets, 'IPSet');
                        console.log(ipSets.length + ' IP Sets in total');
                    }
                    callback(err, ipSets);
                });
            }
        ], function (err, rangesAndIPSets) {
            if (err) {
                done(context, err, 'Error getting ranges and/or IP sets');
            } else {
                // rangesAndIPSets is an array with two elements - the first is an array of ranges, the second an array of IPSets
                var ranges = rangesAndIPSets[0];
                var ipSets = rangesAndIPSets[1];
                var tasks = [];
                ipSets.forEach(function (ipSet, index) {
                    var ipSetName = ipSet.Name;
                    var ipSetDescriptors = ipSet.IPSetDescriptors;
                    var begin = index * maxDescriptorsPerIpSet;
                    var rangeSlice = ranges.slice(begin, begin + maxDescriptorsPerIpSet);
                    console.log('IP Set ' + ipSetName + ' has ' + ipSetDescriptors.length + ' descriptors and should have ' + rangeSlice.length);
                    var updates = [];
                    ipSetDescriptors.forEach(function (ipSetDescriptor) {
                        var cidr = ipSetDescriptor.Value;
                        var found;
                        // try to find the IPSet descriptor on the ranges slice
                        for (var i = 0; i < rangeSlice.length; i++) {
                            if (rangeSlice[i].cidr === cidr) {
                                rangeSlice.splice(i, 1);
                                found = true;
                                break;
                            }
                        }
                        // if this descriptor is not found in the ranges slice, it is deleted 
                        if (!found) updates.push({ Action: 'DELETE', IPSetDescriptor: ipSetDescriptor });
                    });
                    // all the ranges not existing the IPSet are inserted
                    Array.prototype.push.apply(updates, rangeSlice.map(function (range) {
                        return { Action: 'INSERT', IPSetDescriptor: { Type: 'IPV4', Value: range.cidr } };
                    }));
                    var updatesLength = updates.length;
                    if (updatesLength > 0) {
                        console.log('IP Set ' + ipSetName + ' requires ' + updatesLength + ' updates');
                        //console.log('IP Set ' + ipSetName + ' updates: ' + updates.map(function (o) {
                        //    return o.Action + ' ' + o.IPSetDescriptor.Value;
                        //}).join(', '));
                        // limit the number of updates in a single call
                        var batches = [];
                        while (updates.length) {
                            batches.push(updates.splice(0, maxDescriptorsPerIpSetUpdate));
                        }
                        Array.prototype.push.apply(tasks, batches.map(function(updateBatch) {
                            return function (callback) {
                                async.waterfall([
                                    function (callback) {
                                        waf.getChangeToken({}, callback);
                                    },
                                    function (response, callback) {
                                        console.log('Updating IP set ' + ipSetName + ' with ' + updateBatch.length + ' updates');
                                        waf.updateIPSet({
                                            ChangeToken: response.ChangeToken,
                                            IPSetId: ipSet.IPSetId,
                                            Updates: updateBatch
                                        }, callback);
                                    }
                                ], function (err, response) {
                                    if (err) {
                                        console.error('Error updating IP set ' + ipSetName, err);
                                    } else {
                                        console.log('Updated IP set ' + ipSetName);
                                    }
                                    callback(err);
                                });
                            };
                        }));
                    } else {
                        // there are no updates for this IP Set
                        console.log('No update required for IP set' + ipSetName);
                    }
                });
                if (tasks.length > 0) {
                    // there are update tasks to be performed - i.e. there are IP Sets that require updating
                    async.series(tasks, function (err) {
                        var notFitCount = ranges.length - (ipSets.length * maxDescriptorsPerIpSet);
                        done(context, err, err ? 'Error updating IP sets' : 'Updated IP sets' + (notFitCount > 0 ? ', ' + notFitCount + ' ranges unable to fit in IP sets' : ''));
                    });
                } else {
                    done(context, null, 'No updates required for IP sets');
                }
            }
        });
    }
};