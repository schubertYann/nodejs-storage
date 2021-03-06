/**
 * Copyright 2014 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

var assert = require('assert');
var async = require('async');
var Buffer = require('safe-buffer').Buffer;
var crypto = require('crypto');
var extend = require('extend');
var fs = require('fs');
var is = require('is');
var normalizeNewline = require('normalize-newline');
var path = require('path');
var prop = require('propprop');
var request = require('request');
var through = require('through2');
var tmp = require('tmp');
var uuid = require('uuid');

var util = require('@google-cloud/common').util;

var Storage = require('../');
var Bucket = Storage.Bucket;
var File = Storage.File;
var PubSub = require('@google-cloud/pubsub');

describe('storage', function() {
  var USER_ACCOUNT = 'user-spsawchuk@gmail.com';
  var TESTS_PREFIX = 'gcloud-storage-tests-';

  var storage = new Storage({});
  var bucket = storage.bucket(generateName());

  var pubsub = new PubSub({
    projectId: process.env.PROJECT_ID,
  });
  var topic;

  var FILES = {
    logo: {
      path: path.join(__dirname, 'data/CloudPlatform_128px_Retina.png'),
    },
    big: {
      path: path.join(__dirname, 'data/three-mb-file.tif'),
    },
    html: {
      path: path.join(__dirname, 'data/long-html-file.html'),
    },
    gzip: {
      path: path.join(__dirname, 'data/long-html-file.html.gz'),
    },
  };

  before(function() {
    return bucket
      .create()
      .then(function() {
        return pubsub.createTopic(generateName());
      })
      .then(function(data) {
        topic = data[0];
        return topic.iam.setPolicy({
          bindings: [
            {
              role: 'roles/pubsub.editor',
              members: ['allUsers'],
            },
          ],
        });
      });
  });

  after(function(done) {
    async.parallel([deleteAllBuckets, deleteAllTopics], done);
  });

  describe('without authentication', function() {
    var privateBucket;
    var privateFile;
    var storageWithoutAuth;

    var GOOGLE_APPLICATION_CREDENTIALS;

    before(function(done) {
      privateBucket = bucket; // `bucket` was created in the global `before`
      privateFile = privateBucket.file('file-name');

      privateFile.save('data', function(err) {
        if (err) {
          done(err);
          return;
        }

        // CI authentication is done with ADC. Cache it here, restore it `after`
        GOOGLE_APPLICATION_CREDENTIALS =
          process.env.GOOGLE_APPLICATION_CREDENTIALS;
        delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

        storageWithoutAuth = require('../')();

        done();
      });
    });

    after(function() {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = GOOGLE_APPLICATION_CREDENTIALS;
    });

    describe('public data', function() {
      var bucket;

      before(function() {
        bucket = storageWithoutAuth.bucket('gcp-public-data-landsat');
      });

      it('should list and download a file', function(done) {
        bucket.getFiles(
          {
            autoPaginate: false,
          },
          function(err, files) {
            assert.ifError(err);

            var file = files[0];

            file.download(done);
          }
        );
      });
    });

    describe('private data', function() {
      var bucket;
      var file;

      before(function() {
        bucket = storageWithoutAuth.bucket(privateBucket.id);
        file = bucket.file(privateFile.id);
      });

      it('should not download a file', function(done) {
        file.download(function(err) {
          assert(err.message.indexOf('does not have storage.objects.get') > -1);
          done();
        });
      });

      it('should not upload a file', function(done) {
        file.save('new data', function(err) {
          assert(err.message.indexOf('Could not authenticate') > -1);
          done();
        });
      });
    });
  });

  describe('acls', function() {
    describe('buckets', function() {
      it('should get access controls', function(done) {
        bucket.acl.get(function(err, accessControls) {
          assert.ifError(err);
          assert(Array.isArray(accessControls));
          done();
        });
      });

      it('should add entity to default access controls', function(done) {
        bucket.acl.default.add(
          {
            entity: USER_ACCOUNT,
            role: storage.acl.OWNER_ROLE,
          },
          function(err, accessControl) {
            assert.ifError(err);
            assert.equal(accessControl.role, storage.acl.OWNER_ROLE);

            bucket.acl.default.get(
              {
                entity: USER_ACCOUNT,
              },
              function(err, accessControl) {
                assert.ifError(err);
                assert.equal(accessControl.role, storage.acl.OWNER_ROLE);

                bucket.acl.default.update(
                  {
                    entity: USER_ACCOUNT,
                    role: storage.acl.READER_ROLE,
                  },
                  function(err, accessControl) {
                    assert.ifError(err);
                    assert.equal(accessControl.role, storage.acl.READER_ROLE);

                    bucket.acl.default.delete({entity: USER_ACCOUNT}, done);
                  }
                );
              }
            );
          }
        );
      });

      it('should get default access controls', function(done) {
        bucket.acl.default.get(function(err, accessControls) {
          assert.ifError(err);
          assert(Array.isArray(accessControls));
          done();
        });
      });

      it('should grant an account access', function(done) {
        bucket.acl.add(
          {
            entity: USER_ACCOUNT,
            role: storage.acl.OWNER_ROLE,
          },
          function(err, accessControl) {
            assert.ifError(err);
            assert.equal(accessControl.role, storage.acl.OWNER_ROLE);

            var opts = {entity: USER_ACCOUNT};

            bucket.acl.get(opts, function(err, accessControl) {
              assert.ifError(err);
              assert.equal(accessControl.role, storage.acl.OWNER_ROLE);

              bucket.acl.delete(opts, done);
            });
          }
        );
      });

      it('should update an account', function(done) {
        bucket.acl.add(
          {
            entity: USER_ACCOUNT,
            role: storage.acl.OWNER_ROLE,
          },
          function(err, accessControl) {
            assert.ifError(err);
            assert.equal(accessControl.role, storage.acl.OWNER_ROLE);

            bucket.acl.update(
              {
                entity: USER_ACCOUNT,
                role: storage.acl.WRITER_ROLE,
              },
              function(err, accessControl) {
                assert.ifError(err);
                assert.equal(accessControl.role, storage.acl.WRITER_ROLE);

                bucket.acl.delete({entity: USER_ACCOUNT}, done);
              }
            );
          }
        );
      });

      it('should make a bucket public', function(done) {
        bucket.makePublic(function(err) {
          assert.ifError(err);
          bucket.acl.get({entity: 'allUsers'}, function(err, aclObject) {
            assert.ifError(err);
            assert.deepEqual(aclObject, {entity: 'allUsers', role: 'READER'});
            bucket.acl.delete({entity: 'allUsers'}, done);
          });
        });
      });

      it('should make files public', function(done) {
        async.each(['a', 'b', 'c'], createFileWithContent, function(err) {
          assert.ifError(err);

          bucket.makePublic({includeFiles: true}, function(err) {
            assert.ifError(err);

            bucket.getFiles(function(err, files) {
              assert.ifError(err);

              async.each(files, isFilePublic, function(err) {
                assert.ifError(err);

                async.parallel(
                  [
                    function(next) {
                      bucket.acl.default.delete({entity: 'allUsers'}, next);
                    },
                    function(next) {
                      bucket.deleteFiles(next);
                    },
                  ],
                  done
                );
              });
            });
          });
        });

        function createFileWithContent(content, callback) {
          bucket.file(generateName() + '.txt').save(content, callback);
        }

        function isFilePublic(file, callback) {
          file.acl.get({entity: 'allUsers'}, function(err, aclObject) {
            if (err) {
              callback(err);
              return;
            }

            if (
              aclObject.entity === 'allUsers' &&
              aclObject.role === 'READER'
            ) {
              callback();
            } else {
              callback(new Error('File is not public.'));
            }
          });
        }
      });

      it('should make a bucket private', function(done) {
        bucket.makePublic(function(err) {
          assert.ifError(err);
          bucket.makePrivate(function(err) {
            assert.ifError(err);
            bucket.acl.get({entity: 'allUsers'}, function(err, aclObject) {
              assert.equal(err.code, 404);
              assert.equal(err.message, 'Not Found');
              assert.equal(aclObject, null);
              done();
            });
          });
        });
      });

      it('should make files private', function(done) {
        async.each(['a', 'b', 'c'], createFileWithContent, function(err) {
          assert.ifError(err);

          bucket.makePrivate({includeFiles: true}, function(err) {
            assert.ifError(err);

            bucket.getFiles(function(err, files) {
              assert.ifError(err);

              async.each(files, isFilePrivate, function(err) {
                assert.ifError(err);

                bucket.deleteFiles(done);
              });
            });
          });
        });

        function createFileWithContent(content, callback) {
          bucket.file(generateName() + '.txt').save(content, callback);
        }

        function isFilePrivate(file, callback) {
          file.acl.get({entity: 'allUsers'}, function(err) {
            if (err && err.code === 404) {
              callback();
            } else {
              callback(new Error('File is not private.'));
            }
          });
        }
      });
    });

    describe('files', function() {
      var file;

      beforeEach(function(done) {
        var options = {
          destination: generateName() + '.png',
        };

        bucket.upload(FILES.logo.path, options, function(err, f) {
          assert.ifError(err);
          file = f;
          done();
        });
      });

      afterEach(function(done) {
        file.delete(done);
      });

      it('should get access controls', function(done) {
        file.acl.get(done, function(err, accessControls) {
          assert.ifError(err);
          assert(Array.isArray(accessControls));
          done();
        });
      });

      it('should not expose default api', function() {
        assert.equal(typeof file.default, 'undefined');
      });

      it('should grant an account access', function(done) {
        file.acl.add(
          {
            entity: USER_ACCOUNT,
            role: storage.acl.OWNER_ROLE,
          },
          function(err, accessControl) {
            assert.ifError(err);
            assert.equal(accessControl.role, storage.acl.OWNER_ROLE);

            file.acl.get({entity: USER_ACCOUNT}, function(err, accessControl) {
              assert.ifError(err);
              assert.equal(accessControl.role, storage.acl.OWNER_ROLE);

              file.acl.delete({entity: USER_ACCOUNT}, done);
            });
          }
        );
      });

      it('should update an account', function(done) {
        file.acl.add(
          {
            entity: USER_ACCOUNT,
            role: storage.acl.OWNER_ROLE,
          },
          function(err, accessControl) {
            assert.ifError(err);
            assert.equal(accessControl.role, storage.acl.OWNER_ROLE);

            file.acl.update(
              {
                entity: USER_ACCOUNT,
                role: storage.acl.READER_ROLE,
              },
              function(err, accessControl) {
                assert.ifError(err);

                assert.equal(accessControl.role, storage.acl.READER_ROLE);

                file.acl.delete({entity: USER_ACCOUNT}, done);
              }
            );
          }
        );
      });

      it('should make a file public', function(done) {
        file.makePublic(function(err) {
          assert.ifError(err);
          file.acl.get({entity: 'allUsers'}, function(err, aclObject) {
            assert.ifError(err);
            assert.deepEqual(aclObject, {entity: 'allUsers', role: 'READER'});
            file.acl.delete({entity: 'allUsers'}, done);
          });
        });
      });

      it('should make a file private', function(done) {
        file.makePublic(function(err) {
          assert.ifError(err);
          file.makePrivate(function(err) {
            assert.ifError(err);
            file.acl.get({entity: 'allUsers'}, function(err, aclObject) {
              assert.equal(err.code, 404);
              assert.equal(err.message, 'Not Found');
              assert.equal(aclObject, null);
              done();
            });
          });
        });
      });

      it('should set custom encryption during the upload', function(done) {
        var key = crypto.randomBytes(32);

        key = '12345678901234567890123456789012';

        bucket.upload(
          FILES.big.path,
          {
            encryptionKey: key,
            resumable: false,
          },
          function(err, file) {
            assert.ifError(err);

            file.getMetadata(function(err, metadata) {
              assert.ifError(err);
              assert.strictEqual(
                metadata.customerEncryption.encryptionAlgorithm,
                'AES256'
              );
              done();
            });
          }
        );
      });

      it('should set custom encryption in a resumable upload', function(done) {
        var key = crypto.randomBytes(32);

        bucket.upload(
          FILES.big.path,
          {
            encryptionKey: key,
            resumable: true,
          },
          function(err, file) {
            assert.ifError(err);

            file.getMetadata(function(err, metadata) {
              assert.ifError(err);
              assert.strictEqual(
                metadata.customerEncryption.encryptionAlgorithm,
                'AES256'
              );
              done();
            });
          }
        );
      });

      it('should make a file public during the upload', function(done) {
        bucket.upload(
          FILES.big.path,
          {
            resumable: false,
            public: true,
          },
          function(err, file) {
            assert.ifError(err);

            file.acl.get({entity: 'allUsers'}, function(err, aclObject) {
              assert.ifError(err);
              assert.deepEqual(aclObject, {
                entity: 'allUsers',
                role: 'READER',
              });
              done();
            });
          }
        );
      });

      it('should make a file public from a resumable upload', function(done) {
        bucket.upload(
          FILES.big.path,
          {
            resumable: true,
            public: true,
          },
          function(err, file) {
            assert.ifError(err);

            file.acl.get({entity: 'allUsers'}, function(err, aclObject) {
              assert.ifError(err);
              assert.deepEqual(aclObject, {
                entity: 'allUsers',
                role: 'READER',
              });
              done();
            });
          }
        );
      });

      it('should make a file private from a resumable upload', function(done) {
        bucket.upload(
          FILES.big.path,
          {
            resumable: true,
            private: true,
          },
          function(err, file) {
            assert.ifError(err);

            file.acl.get({entity: 'allUsers'}, function(err, aclObject) {
              assert.equal(err.code, 404);
              assert.equal(err.message, 'Not Found');
              assert.equal(aclObject, null);
              done();
            });
          }
        );
      });

      it('should upload a file from a URL', function(done) {
        var url =
          'https://pbs.twimg.com/profile_images/839721704163155970/LI_TRk1z_400x400.jpg';

        bucket.upload(url, function(err, file) {
          assert.ifError(err);

          file.download(function(err, contents) {
            assert.ifError(err);

            request(url, function(err, resp, body) {
              assert.ifError(err);
              assert.strictEqual(body.toString(), contents.toString());
              done();
            });
          });
        });
      });
    });
  });

  describe('iam', function() {
    var PROJECT_ID;

    before(function(done) {
      storage.authClient.getProjectId(function(err, projectId) {
        if (err) {
          done(err);
          return;
        }

        PROJECT_ID = projectId;
        done();
      });
    });

    describe('buckets', function() {
      var bucket;

      before(function() {
        bucket = storage.bucket(generateName('bucket'));
        return bucket.create();
      });

      it('should get a policy', function(done) {
        bucket.iam.getPolicy(function(err, policy) {
          assert.ifError(err);

          assert.deepEqual(policy.bindings, [
            {
              members: [
                'projectEditor:' + PROJECT_ID,
                'projectOwner:' + PROJECT_ID,
              ],
              role: 'roles/storage.legacyBucketOwner',
            },
            {
              members: ['projectViewer:' + PROJECT_ID],
              role: 'roles/storage.legacyBucketReader',
            },
          ]);

          done();
        });
      });

      it('should set a policy', function(done) {
        bucket.iam.getPolicy(function(err, policy) {
          assert.ifError(err);

          policy.bindings.push({
            role: 'roles/storage.legacyBucketReader',
            members: ['allUsers'],
          });

          bucket.iam.setPolicy(policy, function(err, newPolicy) {
            assert.ifError(err);

            var legacyBucketReaderBinding = newPolicy.bindings.filter(function(
              binding
            ) {
              return binding.role === 'roles/storage.legacyBucketReader';
            })[0];

            assert(legacyBucketReaderBinding.members.includes('allUsers'));

            done();
          });
        });
      });

      it('should test the iam permissions', function(done) {
        var testPermissions = [
          'storage.buckets.get',
          'storage.buckets.getIamPolicy',
        ];

        bucket.iam.testPermissions(testPermissions, function(err, permissions) {
          assert.ifError(err);

          assert.deepEqual(permissions, {
            'storage.buckets.get': true,
            'storage.buckets.getIamPolicy': true,
          });

          done();
        });
      });
    });
  });

  describe('unicode validation', function() {
    var bucket;

    before(function() {
      bucket = storage.bucket('storage-library-test-bucket');
    });

    // Normalization form C: a single character for e-acute;
    // URL should end with Cafe%CC%81
    it('should not perform normalization form C', function() {
      var name = 'Caf\u00e9';
      var file = bucket.file(name);

      var expectedContents = 'Normalization Form C';

      return file
        .get()
        .then(function(data) {
          var receivedFile = data[0];
          assert.strictEqual(receivedFile.name, name);
          return receivedFile.download();
        })
        .then(function(contents) {
          assert.strictEqual(contents.toString(), expectedContents);
        });
    });

    // Normalization form D: an ASCII character followed by U+0301 combining
    // character; URL should end with Caf%C3%A9
    it('should not perform normalization form D', function() {
      var name = 'Cafe\u0301';
      var file = bucket.file(name);

      var expectedContents = 'Normalization Form D';

      return file
        .get()
        .then(function(data) {
          var receivedFile = data[0];
          assert.strictEqual(receivedFile.name, name);
          return receivedFile.download();
        })
        .then(function(contents) {
          assert.strictEqual(contents.toString(), expectedContents);
        });
    });
  });

  describe('getting buckets', function() {
    var bucketsToCreate = [generateName(), generateName()];

    before(function(done) {
      async.map(bucketsToCreate, storage.createBucket.bind(storage), done);
    });

    after(function(done) {
      async.series(
        bucketsToCreate.map(function(bucket) {
          return function(done) {
            storage.bucket(bucket).delete(done);
          };
        }),
        done
      );
    });

    it('should get buckets', function(done) {
      storage.getBuckets(function(err, buckets) {
        var createdBuckets = buckets.filter(function(bucket) {
          return bucketsToCreate.indexOf(bucket.name) > -1;
        });

        assert.equal(createdBuckets.length, bucketsToCreate.length);
        done();
      });
    });

    it('should get buckets as a stream', function(done) {
      var bucketEmitted = false;

      storage
        .getBucketsStream()
        .on('error', done)
        .on('data', function(bucket) {
          bucketEmitted = bucket instanceof Bucket;
        })
        .on('end', function() {
          assert.strictEqual(bucketEmitted, true);
          done();
        });
    });
  });

  describe('bucket metadata', function() {
    it('should allow setting metadata on a bucket', function(done) {
      var metadata = {
        website: {
          mainPageSuffix: 'http://fakeuri',
          notFoundPage: 'http://fakeuri/404.html',
        },
      };

      bucket.setMetadata(metadata, function(err, meta) {
        assert.ifError(err);
        assert.deepEqual(meta.website, metadata.website);
        done();
      });
    });

    it('should allow changing the storage class', function(done) {
      var bucket = storage.bucket(generateName());

      async.series(
        [
          function(next) {
            bucket.create(next);
          },

          function(next) {
            bucket.getMetadata(function(err, metadata) {
              assert.ifError(err);
              assert.strictEqual(metadata.storageClass, 'STANDARD');
              next();
            });
          },

          function(next) {
            bucket.setStorageClass('multi-regional', next);
          },
        ],
        function(err) {
          assert.ifError(err);

          bucket.getMetadata(function(err, metadata) {
            assert.ifError(err);
            assert.strictEqual(metadata.storageClass, 'MULTI_REGIONAL');
            done();
          });
        }
      );
    });

    describe('labels', function() {
      var LABELS = {
        label: 'labelvalue', // no caps or spaces allowed (?)
        labeltwo: 'labelvaluetwo',
      };

      beforeEach(function(done) {
        bucket.deleteLabels(done);
      });

      it('should set labels', function(done) {
        bucket.setLabels(LABELS, function(err) {
          assert.ifError(err);

          bucket.getLabels(function(err, labels) {
            assert.ifError(err);
            assert.deepStrictEqual(labels, LABELS);
            done();
          });
        });
      });

      it('should update labels', function(done) {
        var newLabels = {
          siblinglabel: 'labelvalue',
        };

        bucket.setLabels(LABELS, function(err) {
          assert.ifError(err);

          bucket.setLabels(newLabels, function(err) {
            assert.ifError(err);

            bucket.getLabels(function(err, labels) {
              assert.ifError(err);
              assert.deepStrictEqual(labels, extend({}, LABELS, newLabels));
              done();
            });
          });
        });
      });

      it('should delete a single label', function(done) {
        if (LABELS.length <= 1) {
          done(new Error('Maintainer Error: `LABELS` needs 2 labels.'));
          return;
        }

        var labelKeyToDelete = Object.keys(LABELS)[0];

        bucket.setLabels(LABELS, function(err) {
          assert.ifError(err);

          bucket.deleteLabels(labelKeyToDelete, function(err) {
            assert.ifError(err);

            bucket.getLabels(function(err, labels) {
              assert.ifError(err);

              var expectedLabels = extend({}, LABELS);
              delete expectedLabels[labelKeyToDelete];

              assert.deepStrictEqual(labels, expectedLabels);

              done();
            });
          });
        });
      });

      it('should delete all labels', function(done) {
        bucket.deleteLabels(function(err) {
          assert.ifError(err);

          bucket.getLabels(function(err, labels) {
            assert.ifError(err);
            assert.deepStrictEqual(labels, {});
            done();
          });
        });
      });
    });
  });

  describe('requester pays', function() {
    var HAS_2ND_PROJECT = is.defined(process.env.GCN_STORAGE_2ND_PROJECT_ID);
    var bucket;

    before(function(done) {
      bucket = storage.bucket(generateName());

      bucket.create(
        {
          requesterPays: true,
        },
        done
      );
    });

    after(function(done) {
      bucket.delete(done);
    });

    it('should have enabled requesterPays functionality', function(done) {
      bucket.getMetadata(function(err, metadata) {
        assert.ifError(err);
        assert.strictEqual(metadata.billing.requesterPays, true);
        done();
      });
    });

    // These tests will verify that the requesterPays functionality works from
    // the perspective of another project.
    (HAS_2ND_PROJECT ? describe : describe.skip)('existing bucket', function() {
      var storageNonWhitelist = new Storage({
        projectId: process.env.GCN_STORAGE_2ND_PROJECT_ID,
        keyFilename: process.env.GCN_STORAGE_2ND_PROJECT_KEY,
      });
      var bucket; // the source bucket, which will have requesterPays enabled.
      var bucketNonWhitelist; // the bucket object from the requesting user.

      function isRequesterPaysEnabled(callback) {
        bucket.getMetadata(function(err, metadata) {
          if (err) {
            callback(err);
            return;
          }

          var billing = metadata.billing || {};
          callback(null, !!billing && billing.requesterPays === true);
        });
      }

      before(function(done) {
        bucket = storage.bucket(generateName());
        bucketNonWhitelist = storageNonWhitelist.bucket(bucket.name);
        bucket.create(done);
      });

      it('should enable requesterPays', function(done) {
        isRequesterPaysEnabled(function(err, isEnabled) {
          assert.ifError(err);
          assert.strictEqual(isEnabled, false);

          bucket.enableRequesterPays(function(err) {
            assert.ifError(err);

            isRequesterPaysEnabled(function(err, isEnabled) {
              assert.ifError(err);
              assert.strictEqual(isEnabled, true);
              done();
            });
          });
        });
      });

      it('should disable requesterPays', function(done) {
        bucket.enableRequesterPays(function(err) {
          assert.ifError(err);

          isRequesterPaysEnabled(function(err, isEnabled) {
            assert.ifError(err);
            assert.strictEqual(isEnabled, true);

            bucket.disableRequesterPays(function(err) {
              assert.ifError(err);

              isRequesterPaysEnabled(function(err, isEnabled) {
                assert.ifError(err);
                assert.strictEqual(isEnabled, false);
                done();
              });
            });
          });
        });
      });

      describe('methods that accept userProject', function() {
        var file;
        var notification;
        var topicName;

        var USER_PROJECT_OPTIONS = {
          userProject: process.env.GCN_STORAGE_2ND_PROJECT_ID,
        };

        // This acts as a test for the following methods:
        //
        // - file.save()
        //   -> file.createWriteStream()
        before(function() {
          file = bucketNonWhitelist.file(generateName('file'));

          return bucket
            .enableRequesterPays()
            .then(() => bucket.iam.getPolicy())
            .then(data => {
              var policy = data[0];

              // Allow an absolute or relative path (from project root)
              // for the key file.
              var key2 = process.env.GCN_STORAGE_2ND_PROJECT_KEY;
              if (key2 && key2.charAt(0) === '.') {
                key2 = `${__dirname}/../${key2}`;
              }

              // Get the service account for the "second" account (the
              // one that will read the requester pays file).
              var clientEmail = require(key2).client_email;

              policy.bindings.push({
                role: 'roles/storage.admin',
                members: [`serviceAccount:${clientEmail}`],
              });

              return bucket.iam.setPolicy(policy);
            })
            .then(() => file.save('abc', USER_PROJECT_OPTIONS))
            .then(() => topic.getMetadata())
            .then(data => {
              topicName = data[0].name;
            });
        });

        // This acts as a test for the following methods:
        //
        //  - bucket.delete({ userProject: ... })
        //    -> bucket.deleteFiles({ userProject: ... })
        //       -> bucket.getFiles({ userProject: ... })
        //          -> file.delete({ userProject: ... })
        after(function(done) {
          deleteBucket(bucketNonWhitelist, USER_PROJECT_OPTIONS, done);
        });

        function doubleTest(testFunction) {
          var failureMessage =
            'Bucket is requester pays bucket but no user project provided.';

          return function(done) {
            async.series(
              [
                function(next) {
                  testFunction({}, function(err) {
                    assert(err.message.indexOf(failureMessage) > -1);
                    next();
                  });
                },

                function(next) {
                  testFunction(USER_PROJECT_OPTIONS, next);
                },
              ],
              done
            );
          };
        }

        it('bucket#combine', function(done) {
          var files = [
            {file: bucketNonWhitelist.file('file-one.txt'), contents: '123'},
            {file: bucketNonWhitelist.file('file-two.txt'), contents: '456'},
          ];

          async.each(files, createFile, function(err) {
            assert.ifError(err);

            var sourceFiles = files.map(prop('file'));
            var destinationFile = bucketNonWhitelist.file('file-one-n-two.txt');

            bucketNonWhitelist.combine(
              sourceFiles,
              destinationFile,
              USER_PROJECT_OPTIONS,
              done
            );
          });

          function createFile(fileObject, callback) {
            fileObject.file.save(
              fileObject.contents,
              USER_PROJECT_OPTIONS,
              callback
            );
          }
        });

        it(
          'bucket#createNotification',
          doubleTest(function(options, done) {
            bucketNonWhitelist.createNotification(topicName, options, function(
              err,
              _notification
            ) {
              notification = _notification;
              done(err);
            });
          })
        );

        it(
          'bucket#exists',
          doubleTest(function(options, done) {
            bucketNonWhitelist.exists(options, done);
          })
        );

        it(
          'bucket#get',
          doubleTest(function(options, done) {
            bucketNonWhitelist.get(options, done);
          })
        );

        it(
          'bucket#getMetadata',
          doubleTest(function(options, done) {
            bucketNonWhitelist.get(options, done);
          })
        );

        it(
          'bucket#getNotifications',
          doubleTest(function(options, done) {
            bucketNonWhitelist.getNotifications(options, done);
          })
        );

        it(
          'bucket#makePrivate',
          doubleTest(function(options, done) {
            bucketNonWhitelist.makePrivate(options, done);
          })
        );

        it(
          'bucket#setMetadata',
          doubleTest(function(options, done) {
            bucketNonWhitelist.setMetadata({newMetadata: true}, options, done);
          })
        );

        it(
          'bucket#setStorageClass',
          doubleTest(function(options, done) {
            bucketNonWhitelist.setStorageClass('multi-regional', options, done);
          })
        );

        it(
          'bucket#upload',
          doubleTest(function(options, done) {
            bucketNonWhitelist.upload(FILES.big.path, options, done);
          })
        );

        it(
          'file#copy',
          doubleTest(function(options, done) {
            file.copy('new-file.txt', options, done);
          })
        );

        it(
          'file#createReadStream',
          doubleTest(function(options, done) {
            file
              .createReadStream(options)
              .on('error', done)
              .on('end', done)
              .on('data', util.noop);
          })
        );

        it(
          'file#createResumableUpload',
          doubleTest(function(options, done) {
            file.createResumableUpload(options, done);
          })
        );

        it(
          'file#download',
          doubleTest(function(options, done) {
            file.download(options, done);
          })
        );

        it(
          'file#exists',
          doubleTest(function(options, done) {
            file.exists(options, done);
          })
        );

        it(
          'file#get',
          doubleTest(function(options, done) {
            file.get(options, done);
          })
        );

        it(
          'file#getMetadata',
          doubleTest(function(options, done) {
            file.getMetadata(options, done);
          })
        );

        it(
          'file#makePrivate',
          doubleTest(function(options, done) {
            file.makePrivate(options, done);
          })
        );

        it(
          'file#move',
          doubleTest(function(options, done) {
            var newFile = bucketNonWhitelist.file(generateName('file'));

            file.move(newFile, options, function(err) {
              if (err) {
                done(err);
                return;
              }

              // Re-create the file. The tests need it.
              file.save('newcontent', done);
            });
          })
        );

        it(
          'file#setMetadata',
          doubleTest(function(options, done) {
            file.setMetadata({newMetadata: true}, options, done);
          })
        );

        it(
          'file#setStorageClass',
          doubleTest(function(options, done) {
            file.setStorageClass('multi-regional', options, done);
          })
        );

        it(
          'acl#add',
          doubleTest(function(options, done) {
            options = extend(
              {
                entity: USER_ACCOUNT,
                role: storage.acl.OWNER_ROLE,
              },
              options
            );

            bucketNonWhitelist.acl.add(options, done);
          })
        );

        it(
          'acl#update',
          doubleTest(function(options, done) {
            options = extend(
              {
                entity: USER_ACCOUNT,
                role: storage.acl.WRITER_ROLE,
              },
              options
            );

            bucketNonWhitelist.acl.update(options, done);
          })
        );

        it(
          'acl#get',
          doubleTest(function(options, done) {
            options = extend(
              {
                entity: USER_ACCOUNT,
              },
              options
            );

            bucketNonWhitelist.acl.get(options, done);
          })
        );

        it(
          'acl#delete',
          doubleTest(function(options, done) {
            options = extend(
              {
                entity: USER_ACCOUNT,
              },
              options
            );

            bucketNonWhitelist.acl.delete(options, done);
          })
        );

        it(
          'iam#getPolicy',
          doubleTest(function(options, done) {
            bucketNonWhitelist.iam.getPolicy(options, done);
          })
        );

        it(
          'iam#setPolicy',
          doubleTest(function(options, done) {
            bucket.iam.getPolicy(function(err, policy) {
              if (err) {
                done(err);
                return;
              }

              policy.bindings.push({
                role: 'roles/storage.objectViewer',
                members: ['allUsers'],
              });

              bucketNonWhitelist.iam.setPolicy(policy, options, done);
            });
          })
        );

        it(
          'iam#testPermissions',
          doubleTest(function(options, done) {
            var tests = ['storage.buckets.delete'];
            bucketNonWhitelist.iam.testPermissions(tests, options, done);
          })
        );

        it(
          'notification#get',
          doubleTest(function(options, done) {
            if (!notification) {
              throw new Error('Notification was not successfully created.');
            }

            notification.get(options, done);
          })
        );

        it(
          'notification#getMetadata',
          doubleTest(function(options, done) {
            if (!notification) {
              throw new Error('Notification was not successfully created.');
            }

            notification.getMetadata(options, done);
          })
        );

        it(
          'notification#delete',
          doubleTest(function(options, done) {
            if (!notification) {
              throw new Error('Notification was not successfully created.');
            }

            notification.delete(options, done);
          })
        );
      });
    });
  });

  describe('write, read, and remove files', function() {
    before(function(done) {
      function setHash(filesKey, done) {
        var file = FILES[filesKey];
        var hash = crypto.createHash('md5');

        fs
          .createReadStream(file.path)
          .on('data', hash.update.bind(hash))
          .on('end', function() {
            file.hash = hash.digest('base64');
            done();
          });
      }

      async.each(Object.keys(FILES), setHash, done);
    });

    it('should read/write from/to a file in a directory', function(done) {
      var file = bucket.file('directory/file');
      var contents = 'test';

      var writeStream = file.createWriteStream({resumable: false});
      writeStream.write(contents);
      writeStream.end();

      writeStream.on('error', done);
      writeStream.on('finish', function() {
        var data = Buffer.from('');

        file
          .createReadStream()
          .on('error', done)
          .on('data', function(chunk) {
            data = Buffer.concat([data, chunk]);
          })
          .on('end', function() {
            assert.equal(data.toString(), contents);
            done();
          });
      });
    });

    it('should not push data when a file cannot be read', function(done) {
      var file = bucket.file('non-existing-file');
      var dataEmitted = false;

      file
        .createReadStream()
        .on('data', function() {
          dataEmitted = true;
        })
        .on('error', function(err) {
          assert.strictEqual(dataEmitted, false);
          assert.strictEqual(err.code, 404);
          done();
        });
    });

    it('should read a byte range from a file', function(done) {
      bucket.upload(FILES.big.path, function(err, file) {
        assert.ifError(err);

        var fileSize = file.metadata.size;
        var byteRange = {
          start: Math.floor(fileSize * 1 / 3),
          end: Math.floor(fileSize * 2 / 3),
        };
        var expectedContentSize = byteRange.start + 1;

        var sizeStreamed = 0;
        file
          .createReadStream(byteRange)
          .on('data', function(chunk) {
            sizeStreamed += chunk.length;
          })
          .on('error', done)
          .on('end', function() {
            assert.equal(sizeStreamed, expectedContentSize);
            file.delete(done);
          });
      });
    });

    it('should download a file to memory', function(done) {
      var fileContents = fs.readFileSync(FILES.big.path);

      bucket.upload(FILES.big.path, function(err, file) {
        assert.ifError(err);

        file.download(function(err, remoteContents) {
          assert.ifError(err);
          assert.equal(String(fileContents), String(remoteContents));
          done();
        });
      });
    });

    it('should handle non-network errors', function(done) {
      var file = bucket.file('hi.jpg');
      file.download(function(err) {
        assert.strictEqual(err.code, 404);
        done();
      });
    });

    it('should gzip a file on the fly and download it', function(done) {
      var options = {
        gzip: true,
      };

      var expectedContents = fs.readFileSync(FILES.html.path, 'utf-8');

      bucket.upload(FILES.html.path, options, function(err, file) {
        assert.ifError(err);

        file.download(function(err, contents) {
          assert.ifError(err);
          assert.strictEqual(contents.toString(), expectedContents);
          file.delete(done);
        });
      });
    });

    it('should upload a gzipped file and download it', function(done) {
      var options = {
        metadata: {
          contentEncoding: 'gzip',
          contentType: 'text/html',
        },
      };

      var expectedContents = normalizeNewline(
        fs.readFileSync(FILES.html.path, 'utf-8')
      );

      bucket.upload(FILES.gzip.path, options, function(err, file) {
        assert.ifError(err);

        // Sometimes this file is not found immediately; include some
        // retry to attempt to make the test less flaky.
        var attempt = 0;
        var downloadCallback = (err, contents) => {
          // If we got an error, gracefully retry a few times.
          if (err) {
            attempt += 1;
            if (attempt >= 5) {
              return assert.ifError(err);
            }
            return file.download(downloadCallback);
          }

          // Ensure the contents match.
          assert.strictEqual(contents.toString(), expectedContents);
          file.delete(done);
        };
        file.download(downloadCallback);
      });
    });

    describe('simple write', function() {
      it('should save arbitrary data', function(done) {
        var file = bucket.file('TestFile');
        var data = 'hello';

        file.save(data, function(err) {
          assert.ifError(err);

          file.download(function(err, contents) {
            assert.strictEqual(contents.toString(), data);
            done();
          });
        });
      });
    });

    describe('stream write', function() {
      it('should stream write, then remove file (3mb)', function(done) {
        var file = bucket.file('LargeFile');
        fs
          .createReadStream(FILES.big.path)
          .pipe(file.createWriteStream({resumable: false}))
          .on('error', done)
          .on('finish', function() {
            assert.equal(file.metadata.md5Hash, FILES.big.hash);
            file.delete(done);
          });
      });

      it('should write metadata', function(done) {
        var options = {
          metadata: {contentType: 'image/png'},
          resumable: false,
        };

        bucket.upload(FILES.logo.path, options, function(err, file) {
          assert.ifError(err);

          file.getMetadata(function(err, metadata) {
            assert.ifError(err);
            assert.equal(metadata.contentType, options.metadata.contentType);
            file.delete(done);
          });
        });
      });

      it('should resume an upload after an interruption', function(done) {
        fs.stat(FILES.big.path, function(err, metadata) {
          assert.ifError(err);

          // Use a random name to force an empty ConfigStore cache.
          var file = bucket.file(generateName());
          var fileSize = metadata.size;

          upload({interrupt: true}, function(err) {
            assert.strictEqual(err.message, 'Interrupted.');

            upload({interrupt: false}, function(err) {
              assert.ifError(err);

              assert.equal(file.metadata.size, fileSize);
              file.delete(done);
            });
          });

          function upload(opts, callback) {
            var ws = file.createWriteStream();
            var sizeStreamed = 0;

            fs
              .createReadStream(FILES.big.path)
              .pipe(
                through(function(chunk, enc, next) {
                  sizeStreamed += chunk.length;

                  if (opts.interrupt && sizeStreamed >= fileSize / 2) {
                    // stop sending data half way through.
                    this.push(chunk);
                    this.destroy();
                    ws.destroy(new Error('Interrupted.'));
                  } else {
                    this.push(chunk);
                    next();
                  }
                })
              )
              .pipe(ws)
              .on('error', callback)
              .on('finish', callback);
          }
        });
      });

      it('should write/read/remove from a buffer', function(done) {
        tmp.setGracefulCleanup();
        tmp.file(function _tempFileCreated(err, tmpFilePath) {
          assert.ifError(err);

          var file = bucket.file('MyBuffer');
          var fileContent = 'Hello World';

          var writable = file.createWriteStream();

          writable.write(fileContent);
          writable.end();

          writable.on('finish', function() {
            file
              .createReadStream()
              .on('error', done)
              .pipe(fs.createWriteStream(tmpFilePath))
              .on('error', done)
              .on('finish', function() {
                file.delete(function(err) {
                  assert.ifError(err);

                  fs.readFile(tmpFilePath, function(err, data) {
                    assert.equal(data, fileContent);
                    done();
                  });
                });
              });
          });
        });
      });
    });

    describe('customer-supplied encryption keys', function() {
      var encryptionKey = crypto.randomBytes(32);

      var file = bucket.file('encrypted-file', {
        encryptionKey: encryptionKey,
      });
      var unencryptedFile = bucket.file(file.name);

      before(function(done) {
        file.save('secret data', {resumable: false}, done);
      });

      it('should not get the hashes from the unencrypted file', function(done) {
        unencryptedFile.getMetadata(function(err, metadata) {
          assert.ifError(err);
          assert.strictEqual(metadata.crc32c, undefined);
          done();
        });
      });

      it('should get the hashes from the encrypted file', function(done) {
        file.getMetadata(function(err, metadata) {
          assert.ifError(err);
          assert.notStrictEqual(metadata.crc32c, undefined);
          done();
        });
      });

      it('should not download from the unencrypted file', function(done) {
        unencryptedFile.download(function(err) {
          assert(
            err.message.indexOf(
              [
                'The target object is encrypted by a',
                'customer-supplied encryption key.',
              ].join(' ')
            ) > -1
          );
          done();
        });
      });

      it('should download from the encrytped file', function(done) {
        file.download(function(err, contents) {
          assert.ifError(err);
          assert.strictEqual(contents.toString(), 'secret data');
          done();
        });
      });

      it('should rotate encryption keys', function(done) {
        var newEncryptionKey = crypto.randomBytes(32);

        file.rotateEncryptionKey(newEncryptionKey, function(err) {
          assert.ifError(err);
          file.download(function(err, contents) {
            assert.ifError(err);
            assert.strictEqual(contents.toString(), 'secret data');
            done();
          });
        });
      });
    });

    it('should copy an existing file', function(done) {
      var opts = {destination: 'CloudLogo'};
      bucket.upload(FILES.logo.path, opts, function(err, file) {
        assert.ifError(err);

        file.copy('CloudLogoCopy', function(err, copiedFile) {
          assert.ifError(err);
          async.parallel(
            [file.delete.bind(file), copiedFile.delete.bind(copiedFile)],
            done
          );
        });
      });
    });

    it('should copy a large file', function(done) {
      var otherBucket = storage.bucket(generateName());
      var file = bucket.file('Big');
      var copiedFile = otherBucket.file(file.name);

      async.series(
        [
          function(callback) {
            var opts = {destination: file};
            bucket.upload(FILES.logo.path, opts, callback);
          },
          function(callback) {
            otherBucket.create(
              {
                location: 'ASIA-EAST1',
                dra: true,
              },
              callback
            );
          },
          function(callback) {
            file.copy(copiedFile, callback);
          },
        ],
        function(err) {
          assert.ifError(err);
          async.series(
            [
              copiedFile.delete.bind(copiedFile),
              otherBucket.delete.bind(otherBucket),
              file.delete.bind(file),
            ],
            done
          );
        }
      );
    });

    it('should copy to another bucket given a gs:// URL', function(done) {
      var opts = {destination: 'CloudLogo'};
      bucket.upload(FILES.logo.path, opts, function(err, file) {
        assert.ifError(err);

        var otherBucket = storage.bucket(generateName());
        otherBucket.create(function(err) {
          assert.ifError(err);

          var destPath = 'gs://' + otherBucket.name + '/CloudLogoCopy';
          file.copy(destPath, function(err) {
            assert.ifError(err);

            otherBucket.getFiles(function(err, files) {
              assert.ifError(err);

              assert.strictEqual(files.length, 1);
              var newFile = files[0];

              assert.strictEqual(newFile.name, 'CloudLogoCopy');

              done();
            });
          });
        });
      });
    });

    it('should allow changing the storage class', function(done) {
      var file = bucket.file(generateName());

      async.series(
        [
          function(next) {
            bucket.upload(FILES.logo.path, {destination: file}, next);
          },

          function(next) {
            file.setStorageClass('standard', next);
          },

          function(next) {
            file.getMetadata(function(err, metadata) {
              assert.ifError(err);
              assert.strictEqual(metadata.storageClass, 'STANDARD');
              next();
            });
          },

          function(next) {
            file.setStorageClass('multi-regional', next);
          },
        ],
        function(err) {
          assert.ifError(err);

          file.getMetadata(function(err, metadata) {
            assert.ifError(err);
            assert.strictEqual(metadata.storageClass, 'MULTI_REGIONAL');
            done();
          });
        }
      );
    });
  });

  describe('channels', function() {
    it('should create a channel', function(done) {
      var config = {
        address: 'https://yahoo.com',
      };

      bucket.createChannel('new-channel', config, function(err) {
        // Actually creating a channel is pretty complicated. This will at least
        // let us know we hit the right endpoint and it received "yahoo.com".
        assert.strictEqual(
          err.message,
          'Unauthorized WebHook callback channel: ' + config.address
        );

        done();
      });
    });

    it('should stop a channel', function(done) {
      // We can't actually create a channel. But we can test to see that we're
      // reaching the right endpoint with the API request.
      var channel = storage.channel('id', 'resource-id');
      channel.stop(function(err) {
        assert.strictEqual(err.code, 404);
        assert.strictEqual(err.message.indexOf("Channel 'id' not found"), 0);
        done();
      });
    });
  });

  describe('combine files', function() {
    it('should combine multiple files into one', function(done) {
      var files = [
        {file: bucket.file('file-one.txt'), contents: '123'},
        {file: bucket.file('file-two.txt'), contents: '456'},
      ];

      async.each(files, createFile, function(err) {
        assert.ifError(err);

        var sourceFiles = files.map(prop('file'));
        var destinationFile = bucket.file('file-one-and-two.txt');

        bucket.combine(sourceFiles, destinationFile, function(err) {
          assert.ifError(err);

          destinationFile.download(function(err, contents) {
            assert.ifError(err);

            assert.equal(contents, files.map(prop('contents')).join(''));

            async.each(sourceFiles.concat([destinationFile]), deleteFile, done);
          });
        });
      });

      function createFile(fileObject, callback) {
        fileObject.file.save(fileObject.contents, callback);
      }
    });
  });

  describe('list files', function() {
    var NEW_FILES = [
      bucket.file('CloudLogo1'),
      bucket.file('CloudLogo2'),
      bucket.file('CloudLogo3'),
    ];

    before(function(done) {
      bucket.deleteFiles(function(err) {
        assert.ifError(err);

        var originalFile = NEW_FILES[0];
        var copiedFile1 = NEW_FILES[1];
        var copiedFile2 = NEW_FILES[2];

        fs
          .createReadStream(FILES.logo.path)
          .pipe(originalFile.createWriteStream())
          .on('error', done)
          .on('finish', function() {
            originalFile.copy(copiedFile1, function(err) {
              assert.ifError(err);
              copiedFile1.copy(copiedFile2, done);
            });
          });
      });
    });

    after(function(done) {
      async.each(NEW_FILES, deleteFile, done);
    });

    it('should get files', function(done) {
      bucket.getFiles(function(err, files) {
        assert.ifError(err);
        assert.equal(files.length, NEW_FILES.length);
        done();
      });
    });

    it('should get files as a stream', function(done) {
      var fileEmitted = false;

      bucket
        .getFilesStream()
        .on('error', done)
        .on('data', function(file) {
          fileEmitted = file instanceof File;
        })
        .on('end', function() {
          assert.strictEqual(fileEmitted, true);
          done();
        });
    });

    it('should paginate the list', function(done) {
      var query = {
        maxResults: NEW_FILES.length - 1,
      };

      bucket.getFiles(query, function(err, files, nextQuery) {
        assert.ifError(err);
        assert.equal(files.length, NEW_FILES.length - 1);
        assert(nextQuery);
        bucket.getFiles(nextQuery, function(err, files) {
          assert.ifError(err);
          assert.equal(files.length, 1);
          done();
        });
      });
    });
  });

  describe('file generations', function() {
    var bucketWithVersioning = storage.bucket(generateName());

    before(function(done) {
      bucketWithVersioning.create(
        {
          versioning: {
            enabled: true,
          },
        },
        done
      );
    });

    after(function(done) {
      bucketWithVersioning.deleteFiles(
        {
          versions: true,
        },
        function(err) {
          if (err) {
            done(err);
            return;
          }

          bucketWithVersioning.delete(done);
        }
      );
    });

    it('should overwrite file, then get older version', function(done) {
      var versionedFile = bucketWithVersioning.file(generateName());

      versionedFile.save('a', function(err) {
        assert.ifError(err);

        versionedFile.getMetadata(function(err, metadata) {
          assert.ifError(err);

          var initialGeneration = metadata.generation;

          versionedFile.save('b', function(err) {
            assert.ifError(err);

            var firstGenFile = bucketWithVersioning.file(versionedFile.name, {
              generation: initialGeneration,
            });

            firstGenFile.download(function(err, contents) {
              assert.ifError(err);
              assert.equal(contents, 'a');
              done();
            });
          });
        });
      });
    });

    it('should get all files scoped to their version', function(done) {
      var filesToCreate = [
        {file: bucketWithVersioning.file('file-one.txt'), contents: '123'},
        {file: bucketWithVersioning.file('file-one.txt'), contents: '456'},
      ];

      async.each(filesToCreate, createFile, function(err) {
        assert.ifError(err);

        bucketWithVersioning.getFiles({versions: true}, function(err, files) {
          assert.ifError(err);

          // same file.
          assert.equal(files[0].name, files[1].name);

          // different generations.
          assert.notEqual(
            files[0].metadata.generation,
            files[1].metadata.generation
          );

          done();
        });
      });

      function createFile(fileObject, callback) {
        fileObject.file.save(fileObject.contents, callback);
      }
    });
  });

  describe('sign urls', function() {
    var localFile = fs.readFileSync(FILES.logo.path);
    var file;

    before(function(done) {
      file = bucket.file('LogoToSign.jpg');
      fs
        .createReadStream(FILES.logo.path)
        .pipe(file.createWriteStream())
        .on('error', done)
        .on('finish', done.bind(null, null));
    });

    it('should create a signed read url', function(done) {
      file.getSignedUrl(
        {
          action: 'read',
          expires: Date.now() + 5000,
        },
        function(err, signedReadUrl) {
          assert.ifError(err);
          request.get(signedReadUrl, function(err, resp, body) {
            assert.ifError(err);
            assert.equal(body, localFile);
            file.delete(done);
          });
        }
      );
    });

    it('should create a signed delete url', function(done) {
      file.getSignedUrl(
        {
          action: 'delete',
          expires: Date.now() + 5000,
        },
        function(err, signedDeleteUrl) {
          assert.ifError(err);
          request.del(signedDeleteUrl, function(err) {
            assert.ifError(err);
            file.getMetadata(function(err) {
              assert.equal(err.code, 404);
              done();
            });
          });
        }
      );
    });
  });

  describe('sign policy', function() {
    var file;

    before(function(done) {
      file = bucket.file('LogoToSign.jpg');
      fs
        .createReadStream(FILES.logo.path)
        .pipe(file.createWriteStream())
        .on('error', done)
        .on('finish', done.bind(null, null));
    });

    beforeEach(function() {
      if (!storage.projectId) {
        this.skip();
      }
    });

    it('should create a policy', function(done) {
      var expires = new Date('10-25-2022');
      var expectedExpiration = new Date(expires).toISOString();

      var options = {
        equals: ['$Content-Type', 'image/jpeg'],
        expires: expires,
        contentLengthRange: {
          min: 0,
          max: 1024,
        },
      };

      file.getSignedPolicy(options, function(err, policy) {
        assert.ifError(err);

        var policyJson;

        try {
          policyJson = JSON.parse(policy.string);
        } catch (e) {
          done(e);
          return;
        }

        assert.strictEqual(policyJson.expiration, expectedExpiration);
        done();
      });
    });
  });

  describe('notifications', function() {
    var notification;
    var subscription;

    before(function() {
      return bucket
        .createNotification(topic, {
          eventTypes: ['OBJECT_FINALIZE'],
        })
        .then(function(data) {
          notification = data[0];
          subscription = topic.subscription(generateName());

          return subscription.create();
        });
    });

    after(function() {
      return subscription
        .delete()
        .then(function() {
          return bucket.getNotifications();
        })
        .then(function(data) {
          return Promise.all(
            data[0].map(function(notification) {
              return notification.delete();
            })
          );
        });
    });

    it('should get an existing notification', function(done) {
      notification.get(function(err) {
        assert.ifError(err);
        assert(!is.empty(notification.metadata));
        done();
      });
    });

    it('should get a notifications metadata', function(done) {
      notification.getMetadata(function(err, metadata) {
        assert.ifError(err);
        assert(is.object(metadata));
        done();
      });
    });

    it('should tell us if a notification exists', function(done) {
      notification.exists(function(err, exists) {
        assert.ifError(err);
        assert(exists);
        done();
      });
    });

    it('should tell us if a notification does not exist', function(done) {
      var notification = bucket.notification('123');

      notification.exists(function(err, exists) {
        assert.ifError(err);
        assert.strictEqual(exists, false);
        done();
      });
    });

    it('should get a list of notifications', function(done) {
      bucket.getNotifications(function(err, notifications) {
        assert.ifError(err);
        assert.strictEqual(notifications.length, 1);
        done();
      });
    });

    it('should emit events to a subscription', function(done) {
      subscription.on('error', done).on('message', function(message) {
        var attrs = message.attributes;
        assert.strictEqual(attrs.eventType, 'OBJECT_FINALIZE');
        done();
      });

      bucket.upload(FILES.logo.path, function(err) {
        if (err) {
          done(err);
        }
      });
    });

    it('should delete a notification', function() {
      var notificationCount = 0;
      var notification;

      return bucket
        .createNotification(topic, {
          eventTypes: ['OBJECT_DELETE'],
        })
        .then(function(data) {
          notification = data[0];
          return bucket.getNotifications();
        })
        .then(function(data) {
          notificationCount = data[0].length;
          return notification.delete();
        })
        .then(function() {
          return bucket.getNotifications();
        })
        .then(function(data) {
          assert.strictEqual(data[0].length, notificationCount - 1);
        });
    });
  });

  function deleteBucket(bucket, options, callback) {
    if (is.fn(options)) {
      callback = options;
      options = {};
    }

    // After files are deleted, eventual consistency may require a bit of a
    // delay to ensure that the bucket recognizes that the files don't exist
    // anymore.
    var CONSISTENCY_DELAY_MS = 250;

    options = extend({}, options, {
      versions: true,
    });

    bucket.deleteFiles(options, function(err) {
      if (err) {
        callback(err);
        return;
      }

      setTimeout(function() {
        bucket.delete(options, callback);
      }, CONSISTENCY_DELAY_MS);
    });
  }

  function deleteFile(file, callback) {
    file.delete(callback);
  }

  function deleteTopic(topic, callback) {
    topic.delete(callback);
  }

  function generateName() {
    return TESTS_PREFIX + uuid.v1();
  }

  function deleteAllBuckets(callback) {
    storage.getBuckets(
      {
        prefix: TESTS_PREFIX,
      },
      function(err, buckets) {
        if (err) {
          callback(err);
          return;
        }

        async.eachLimit(buckets, 10, deleteBucket, callback);
      }
    );
  }

  function deleteAllTopics(callback) {
    pubsub.getTopics(function(err, topics) {
      if (err) {
        callback(err);
        return;
      }

      topics = topics.filter(function(topic) {
        return topic.name.indexOf(TESTS_PREFIX) > -1;
      });

      async.eachLimit(topics, 10, deleteTopic, callback);
    });
  }
});
