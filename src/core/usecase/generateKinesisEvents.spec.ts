import cliProgress from 'cli-progress';
import moment from 'moment';
import { JSONObject } from '../domain/JSONObject';
import { FileSystem } from '../providers/FileSystem';
import { ProgressBar } from '../providers/ProgressBar';
import { StreamClient } from '../providers/StreamClient';
import { GenerateKinesisEvents, Operation } from './GenerateKinesisEvents';

describe('GenerateKinesisEvents', () => {
  const makeSut = () => {
    const mockDirContent = ['1.schema1.table1.json'];
    const mockJsonContent: JSONObject[] = [
      {
        ID: 1,
        NAME: 'Joselito',
      },
    ];
    const progressBar: ProgressBar = {
      createMultiBar: jest.fn().mockReturnValue({
        create: jest.fn().mockReturnValue({
          increment: jest.fn(),
        }),
        stop: jest.fn(),
      }),
    };

    const fileSystem: FileSystem = {
      readJsonFile: jest.fn().mockReturnValue(mockJsonContent),
      readDir: jest.fn().mockReturnValue(mockDirContent),
    };

    const streamClient: StreamClient = {
      send: jest.fn(),
    };

    const sut = new GenerateKinesisEvents(
      fileSystem,
      progressBar,
      streamClient,
    );
    return {
      sut,
      fileSystem,
      progressBar,
      mockJsonContent,
      mockDirContent,
    };
  };

  it('correctly loads file and invoke AWS CLI to put-records on stream', async () => {
    // Given
    const { sut, fileSystem, mockJsonContent, mockDirContent, progressBar } =
      makeSut();
    const now = new Date();
    Date.now = jest.fn().mockReturnValue(now);
    const expectedMultiBar = {
      format:
        '{fileName} [{bar}] {percentage}% | ETA: {eta}s | {value}/{total} {dataType}',
      preset: cliProgress.Presets.shades_classic,
    };
    const expected = {
      partitionKey: '1',
      operation: 'load',
      streamName: 'stream-name',
      recordFileDir: 'fileDir',
      localstackEndpoint: 'http://localhost:4566',
      chunkSize: '1',
      filename: mockDirContent[0],
      recordContent: {
        data: mockJsonContent[0],
        metadata: {
          timestamp: moment(now).format('yyyy-MM-DDTHH:mm:ss.SSSS[Z]'),
          'record-type': 'data',
          operation: 'load',
          'partition-key-type': 'primary-key',
          'schema-name': 'schema1',
          'table-name': 'table1',
        },
      },
    };
    // When
    await sut.invoke({
      partitionKey: expected.partitionKey,
      operation: expected.operation as Operation,
      streamName: expected.streamName,
      recordFileDir: expected.recordFileDir,
      localstackEndpoint: expected.localstackEndpoint,
    });
    // Then
    expect(fileSystem.readDir).toHaveBeenCalledWith(expected.recordFileDir);
    expect(progressBar.createMultiBar).toHaveBeenCalledWith(expectedMultiBar);
    expect(fileSystem.readJsonFile).toHaveBeenCalledWith(
      `${expected.recordFileDir}/${expected.filename}`,
    );
    expect(shell.execute).toHaveBeenCalledWith(
      `aws --endpoint-url=${
        expected.localstackEndpoint
      } kinesis put-records --stream-name ${
        expected.streamName
      } --records Data=${Buffer.from(
        JSON.stringify(expected.recordContent),
      ).toString('base64')},PartitionKey=${expected.partitionKey} `,
    );
  });

  it('throws error if filename is incorrect', async () => {
    // Given
    const { sut, fileSystem } = makeSut();
    const expected = {
      partitionKey: '1',
      operation: 'load',
      streamName: 'stream-name',
      recordFileDir: 'fileDir',
      localstackEndpoint: 'http://localhost:4566',
      chunkSize: '1',
      filename: 'wrong.format',
    };
    fileSystem.readDir = jest.fn().mockReturnValue([expected.filename]);
    // When
    const act = async () => {
      await sut.invoke({
        partitionKey: expected.partitionKey,
        operation: expected.operation as Operation,
        streamName: expected.streamName,
        recordFileDir: expected.recordFileDir,
        localstackEndpoint: expected.localstackEndpoint,
      });
    };
    // Then
    await expect(act).rejects.toThrowError(
      `Invalid file name ${expected.filename}. Files should follow the pattern order.schema.table.json`,
    );
  });

  it('should load files from bigger order to lower order', async () => {
    // Given
    const { sut, shell, mockJsonContent, fileSystem } = makeSut();
    const now = new Date();
    Date.now = jest.fn().mockReturnValue(now);

    const mockDirContent = [
      '1.schema1.table1.json',
      '3.schema3.table3.json',
      '4.schema4.table4.json',
      '2.schema2.table2.json',
    ];

    fileSystem.readDir = jest.fn().mockReturnValue(mockDirContent);

    const eventDefinition = {
      partitionKey: '1',
      operation: 'load',
      streamName: 'stream-name',
      recordFileDir: 'fileDir',
      localstackEndpoint: 'http://localhost:4566',
      chunkSize: '1',
      filename: mockDirContent,
    };

    const descOrderDirContent = mockDirContent.sort().reverse();
    const kinesisEvents = descOrderDirContent.map((fileName) => {
      const fileNameParts = fileName.split('.');
      return {
        data: mockJsonContent[0],
        metadata: {
          timestamp: moment(now).format('yyyy-MM-DDTHH:mm:ss.SSSS[Z]'),
          'record-type': 'data',
          operation: 'load',
          'partition-key-type': 'primary-key',
          'schema-name': fileNameParts[1],
          'table-name': fileNameParts[2],
        },
      };
    });

    // When
    await sut.invoke({
      partitionKey: eventDefinition.partitionKey,
      operation: eventDefinition.operation as Operation,
      streamName: eventDefinition.streamName,
      recordFileDir: eventDefinition.recordFileDir,
      localstackEndpoint: eventDefinition.localstackEndpoint,
    });

    // Then
    expect(shell.execute).toHaveBeenCalledTimes(4);
    kinesisEvents.forEach((dirContent) => {
      expect(shell.execute).toHaveBeenCalledWith(
        `aws --endpoint-url=${
          eventDefinition.localstackEndpoint
        } kinesis put-records --stream-name ${
          eventDefinition.streamName
        } --records Data=${Buffer.from(JSON.stringify(dirContent)).toString(
          'base64',
        )},PartitionKey=${eventDefinition.partitionKey} `,
      );
    });

    // Desc array is now ordered with table4, table3, table2 and table1
    expect(shell.execute).toHaveBeenNthCalledWith(
      1,
      `aws --endpoint-url=${
        eventDefinition.localstackEndpoint
      } kinesis put-records --stream-name ${
        eventDefinition.streamName
      } --records Data=${Buffer.from(JSON.stringify(kinesisEvents[0])).toString(
        'base64',
      )},PartitionKey=${eventDefinition.partitionKey} `,
    );
    expect(shell.execute).toHaveBeenNthCalledWith(
      2,
      `aws --endpoint-url=${
        eventDefinition.localstackEndpoint
      } kinesis put-records --stream-name ${
        eventDefinition.streamName
      } --records Data=${Buffer.from(JSON.stringify(kinesisEvents[1])).toString(
        'base64',
      )},PartitionKey=${eventDefinition.partitionKey} `,
    );
    expect(shell.execute).toHaveBeenNthCalledWith(
      3,
      `aws --endpoint-url=${
        eventDefinition.localstackEndpoint
      } kinesis put-records --stream-name ${
        eventDefinition.streamName
      } --records Data=${Buffer.from(JSON.stringify(kinesisEvents[2])).toString(
        'base64',
      )},PartitionKey=${eventDefinition.partitionKey} `,
    );
    expect(shell.execute).toHaveBeenNthCalledWith(
      4,
      `aws --endpoint-url=${
        eventDefinition.localstackEndpoint
      } kinesis put-records --stream-name ${
        eventDefinition.streamName
      } --records Data=${Buffer.from(JSON.stringify(kinesisEvents[3])).toString(
        'base64',
      )},PartitionKey=${eventDefinition.partitionKey} `,
    );
  });

  it('should return the operation if is valid', () => {
    const expectedOperation = 'load';
    const operation = GenerateKinesisEvents.validateOperation('load');
    expect(operation).toBe(expectedOperation);
  });

  it('should throw an error if operation is not valid', () => {
    const invalidOperation = 'banana';
    const expectedErrorMessage = `Invalid operation ${invalidOperation}. Please Make sure to select one of the following: [LOAD, INSERT, UPDATE, DELETE]`;
    const act = () => GenerateKinesisEvents.validateOperation(invalidOperation);
    expect(act).toThrow(expectedErrorMessage);
  });
});
