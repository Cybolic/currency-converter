'use strict';

/**
 * In Memory currency conversion.
 * The user has the option to create an instance of it or use a pre-created single instance.
 * This new approach uses BinarySearch to find the date.
 * When a day is missig the this will use the nearest day before to do the convertion (e.g weekends)
 */
const zlib = require('zlib');
const async = require('async');
const bs = require('binary-search');
const moment = require('moment');
const fs = require('fs');
const http = require('http');
const AdmZip = require('adm-zip');

const FEED_CSV_SEPARATOR = ',';

let singleInstance;

module.exports = class CurrencyConverter {
  constructor(useExtraMap, storageDir) {
    this.useExtraMap = useExtraMap;
    this.storageDir = storageDir ? storageDir : __dirname;
    this.feedFilepathZipped = this.storageDir + '/eurofxref-hist.zip';
    this.feedFilepath = this.storageDir + '/eurofxref-hist.csv';
    this.updating = false;
    this.data = [];
    this.dataByDate = {};
    this.conversionStrategy = this.useExtraMap === true ? this._useBoth : this._useBinarySearch;
    this.processingQueue = async.queue((task, callback) => {
      this._convert(task.currencyValue, task.conversionDate, task.fromCurrency, task.toCurrency, callback);
    }, 1);
    
    console.log('CurrencyConverter - StorageDir: ' + this.storageDir);
  }

  convert(currencyValue, conversionDate, fromCurrency, toCurrency, callback) {
    
    var parsedValue = parseFloat(currencyValue);
    if (parsedValue != currencyValue) {
      return callback('CurrencyConverter - value is not a number: ' + currencyValue);
    }

    if (fromCurrency === toCurrency) {
      return callback(null, buildResult(parsedValue));
    }

    if (this.processingQueue.length() > 10){
      console.log(`CurrencyConverter - QueueSize: ${this.processingQueue.length()}`);
    }
    
    this.processingQueue.push({
      currencyValue: parsedValue,
      conversionDate: conversionDate,
      fromCurrency: fromCurrency,
      toCurrency: toCurrency
    }, callback);
  }

  _convert(currencyValue, conversionDate, fromCurrency, toCurrency, callback) {
    async.series([
      (callback) => this._checkUpdateRequired(conversionDate, callback),
    ], (err) => {
      if (err) {
        return callback(err);
      }
      this.conversionStrategy(currencyValue, conversionDate, fromCurrency, toCurrency, callback);
    });
  }

  _checkUpdateRequired(conversionDate, callback) {
    fs.stat(this.feedFilepath, (err, stats) => {
      if (err && err.code === 'ENOENT') {
        // file does not exist -> download
        this._updateFile(callback);
        return;
      } else if (err) {
        return callback(err);
      } else {
        if (moment().startOf('day').diff(moment(stats.mtime).startOf('day'), 'days') != 0){
          this._updateFile(callback);
          return;
        } else {
          if (this.data.length === 0) {
            this._updateDataInMemory(callback);
          } else {
            callback();
          }
        }
      }
    });
  }

  _updateFile(callback, attempt_num) {
    console.log(`CurrencyConverter - is updating...`);
    var file = fs.createWriteStream(this.feedFilepathZipped);
    var request = http.get('http://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.zip', (response) => {
      response.pipe(file);
      file.on('finish', () => {
        file.close((err) => {
          if (err) {
            return callback(err);
          }
          // unzip file
          try {
            var zip = new AdmZip(this.feedFilepathZipped);
            zip.extractEntryTo('eurofxref-hist.csv', this.storageDir, false, true);
          } catch (error) {
            file.close((err) => {
              if (err) { /* ignore error */ }
              fs.unlink(this.feedFilepathZipped, (err) => {
                attempt_num = attempt_num || 0;
                if (attempt_num < 1) {
                  return this._updateFile(callback, attempt_num + 1);
                } else {
                  console.warn(`CurrencyConverter - failed to read update data`);
                  return callback(error);
                }
              })
            })
          }
          this._updateDataInMemory(callback);
        });
      });
    }).on('error', (err) => {
      return callback(err);
    });
  }

  _updateDataInMemory(callback) {
    this.dataByDate = {};
    this.data = [];
    fs.readFile(this.feedFilepath, 'utf8', (err, data) => {
      if (err) {
        return callback(err);
      }

      var array = data.toString().split('\n');
      // first line contains currency codes, ignore first column (date)
      var currencyCodes = array.shift().split(FEED_CSV_SEPARATOR);
      currencyCodes.shift();
      for (var i in array) {
        var line = array[i];
        var conversionRates = line.split(FEED_CSV_SEPARATOR);
        var date = conversionRates.shift();

        var currencyObj = {
          date: date
        };

        for (var j = 0; j < currencyCodes.length; j++) {
          currencyObj['' + currencyCodes[j]] = conversionRates[j];
        }
        this.data.push(currencyObj);

        if (this.useExtraMap === true) {
          this.dataByDate[currencyObj.date] = currencyObj;
        }
      }
      console.log(`CurrencyConverter - has updated the data. Records: ${this.data.length}`);
      callback();
    });
  }

  _useBoth(currencyValue, conversionDate, fromCurrency, toCurrency, callback) {
    var conversionsForDay = this.dataByDate[moment(conversionDate).format('YYYY-MM-DD')];
    if (conversionsForDay) {
      try {
        var value = processConversion(conversionsForDay, currencyValue, fromCurrency, toCurrency);
        return callback(null, buildResult(value, conversionsForDay, fromCurrency, toCurrency));
      } catch (err) {
        return callback(err);
      }
    } else {
      this._useBinarySearch(currencyValue, conversionDate, fromCurrency, toCurrency, callback);
    }
  }

  _useBinarySearch(currencyValue, conversionDate, fromCurrency, toCurrency, callback) {
    var index = bs(this.data, {
      date: conversionDate
    }, function(a, b) {
      return moment(b.date).diff(a.date);
    });

    // Gives us the position where the date should be places plus one and negated.
    if (index < 0) {
      index = Math.abs(index) - 1;

      if (index >= this.data.length) {
        return callback('Could not find currency data for date ' + conversionDate.format());
      }
    }

    try {
      var value = processConversion(this.data[index], currencyValue, fromCurrency, toCurrency);
      return callback(null, buildResult(value, this.data[index], fromCurrency, toCurrency));
    } catch (err) {
      return callback(err);
    }
  }

  // Single global instance if the user.
  static getDefaultInstance(){
     if (!singleInstance){
        singleInstance = new CurrencyConverter(false, null);
     }
     return singleInstance;
  }
  
  static getDayEpoch(unixTsInMillis){
     return Math.floor((unixTsInMillis ? unixTsInMillis : new Date())/86400000);
  }
};

function processConversion(conversionsForDay, currencyValue, fromCurrency, toCurrency) {
  // we found our day! now search for currency
  var fromCurrencyConversion = 1;
  if (fromCurrency !== 'EUR') {
    fromCurrencyConversion = conversionsForDay[fromCurrency];
    if (!fromCurrencyConversion) {
      throw new Error('Could not find source currency ' + fromCurrency);
    }
  }

  var toCurrencyConversion = 1;
  if (toCurrency !== 'EUR') {
    toCurrencyConversion = conversionsForDay[toCurrency];
    if (!toCurrencyConversion) {
      throw new Error('Could not find target currency ' + toCurrency);
    }
  }
  return (Math.round(currencyValue / fromCurrencyConversion * toCurrencyConversion * 100) / 100);
}

function buildResult(value, conversionsForDay, fromCurrency, toCurrency){
   return {
      value: value,
      // values used for the conversion (maybe important for debugging )
      usedDate: conversionsForDay ? conversionsForDay.date : null,
      usedFromRate: conversionsForDay ? conversionsForDay[fromCurrency] : 1,
      usedToRate: conversionsForDay ? conversionsForDay[toCurrency] : 1
   }
}
