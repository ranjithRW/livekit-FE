import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Room, RoomEvent, TokenSource } from 'livekit-client';
import { AppConfig } from '@/app-config';
import { toastAlert } from '@/components/livekit/alert-toast';

export function useRoom(appConfig: AppConfig) {
  const aborted = useRef(false);
  const room = useMemo(() => new Room(), []);
  const [isSessionActive, setIsSessionActive] = useState(false);

  useEffect(() => {
    function onDisconnected() {
      console.log('Room disconnected');
      setIsSessionActive(false);
    }

    function onConnected() {
      console.log('Room connected successfully');
      console.log('Room name:', room.name);
      console.log('Local participant:', room.localParticipant.identity);
    }

    function onParticipantConnected(participant: any) {
      console.log('Participant connected:', participant.identity, 'Is agent:', participant.isAgent);
      if (participant.isAgent) {
        console.log('Agent joined the room!');
      }
    }

    function onParticipantDisconnected(participant: any) {
      console.log('Participant disconnected:', participant.identity);
    }

    function onMediaDevicesError(error: Error) {
      toastAlert({
        title: 'Encountered an error with your media devices',
        description: `${error.name}: ${error.message}`,
      });
    }

    room.on(RoomEvent.Connected, onConnected);
    room.on(RoomEvent.Disconnected, onDisconnected);
    room.on(RoomEvent.MediaDevicesError, onMediaDevicesError);
    room.on(RoomEvent.ParticipantConnected, onParticipantConnected);
    room.on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);

    return () => {
      room.off(RoomEvent.Connected, onConnected);
      room.off(RoomEvent.Disconnected, onDisconnected);
      room.off(RoomEvent.MediaDevicesError, onMediaDevicesError);
      room.off(RoomEvent.ParticipantConnected, onParticipantConnected);
      room.off(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
    };
  }, [room]);

  useEffect(() => {
    return () => {
      aborted.current = true;
      room.disconnect();
    };
  }, [room]);

  const tokenSource = useMemo(
    () =>
      TokenSource.custom(async () => {
        const url = new URL(
          process.env.NEXT_PUBLIC_CONN_DETAILS_ENDPOINT ?? '/api/connection-details',
          window.location.origin
        );

        try {
          const res = await fetch(url.toString(), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Sandbox-Id': appConfig.sandboxId ?? '',
            },
            body: JSON.stringify({
              room_config: appConfig.agentName
                ? {
                    agents: [{ agent_name: appConfig.agentName }],
                  }
                : undefined,
            }),
          });
          return await res.json();
        } catch (error) {
          console.error('Error fetching connection details:', error);
          throw new Error('Error fetching connection details!');
        }
      }),
    [appConfig]
  );

  const startSession = useCallback(() => {
    // Prevent multiple simultaneous connection attempts
    if (room.state === 'connected' || room.state === 'connecting') {
      console.log('Connection already in progress, skipping...');
      return;
    }

    // Warn if agentName is not configured
    if (!appConfig.agentName) {
      console.warn('⚠️ agentName is not configured. Make sure to set agentName in app-config.ts for the agent to join the room.');
    } else {
      console.log('Connecting with agent:', appConfig.agentName);
    }

    setIsSessionActive(true);

    const { isPreConnectBufferEnabled } = appConfig;
    tokenSource
      .fetch({ agentName: appConfig.agentName })
      .then((connectionDetails) => {
        console.log('Connection details received:', {
          serverUrl: connectionDetails?.serverUrl,
          hasToken: !!connectionDetails?.participantToken,
        });
        
        // Validate connection details
        if (!connectionDetails?.serverUrl || !connectionDetails?.participantToken) {
          throw new Error('Invalid connection details received');
        }
        
        console.log('Connecting to room...');
        return room.connect(connectionDetails.serverUrl, connectionDetails.participantToken);
      })
      .then(() => {
        // Wait for the Connected event explicitly, as connect() promise may resolve before connection is fully established
        return new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            room.off(RoomEvent.Connected, onConnectedHandler);
            room.off(RoomEvent.Disconnected, onDisconnectedHandler);
            reject(new Error('Connection timeout: Room did not connect within 10 seconds'));
          }, 10000);

          const onConnectedHandler = () => {
            clearTimeout(timeout);
            room.off(RoomEvent.Connected, onConnectedHandler);
            room.off(RoomEvent.Disconnected, onDisconnectedHandler);
            resolve();
          };

          const onDisconnectedHandler = () => {
            clearTimeout(timeout);
            room.off(RoomEvent.Connected, onConnectedHandler);
            room.off(RoomEvent.Disconnected, onDisconnectedHandler);
            reject(new Error('Room disconnected during connection'));
          };

          // Check if already connected
          if (room.state === 'connected') {
            clearTimeout(timeout);
            resolve();
          } else {
            room.on(RoomEvent.Connected, onConnectedHandler);
            room.on(RoomEvent.Disconnected, onDisconnectedHandler);
          }
        });
      })
      .then(() => {
        // Double-check room state before enabling microphone
        if (room.state !== 'connected') {
          console.error('Room state is not connected:', room.state);
          throw new Error(`Cannot enable microphone: Room is in ${room.state} state`);
        }
        
        console.log('Room connected, enabling microphone...');
        console.log('Current participants:', Array.from(room.remoteParticipants.values()).map(p => ({
          identity: p.identity,
          isAgent: p.isAgent,
        })));
        
        // Enable microphone after room connection is fully established
        return room.localParticipant
          .setMicrophoneEnabled(true, undefined, {
            preConnectBuffer: isPreConnectBufferEnabled,
          })
          .catch((error: any) => {
            console.error('Failed to enable microphone:', error);
            // If preConnectBuffer fails, try without it
            if (isPreConnectBufferEnabled && (error?.message?.includes('state: closed') || error?.message?.includes('Publisher'))) {
              console.warn('Retrying microphone enable without preConnectBuffer...');
              return room.localParticipant.setMicrophoneEnabled(true, undefined, {
                preConnectBuffer: false,
              });
            }
            throw error;
          })
      })
      .then(() => {
        console.log('Microphone enabled successfully');
        // Log remote participants after a short delay to see if agent joins
        setTimeout(() => {
          const participants = Array.from(room.remoteParticipants.values());
          console.log('Remote participants after connection:', participants.map(p => ({
            identity: p.identity,
            isAgent: p.isAgent,
            audioTracks: p.audioTrackPublications.size,
            videoTracks: p.videoTrackPublications.size,
          })));
          
          const agent = participants.find(p => p.isAgent);
          if (!agent) {
            console.warn('⚠️ No agent found in room. Make sure:');
            console.warn('  1. agentName is configured correctly in app-config.ts');
            console.warn('  2. Your agent service is running and connected to the same LiveKit server');
            console.warn('  3. The agent has the correct API_KEY and API_SECRET');
          } else {
            console.log('✅ Agent found:', agent.identity);
          }
        }, 2000);
      })
      .catch((error) => {
        if (aborted.current) {
          // Once the effect has cleaned up after itself, drop any errors
          //
          // These errors are likely caused by this effect rerunning rapidly,
          // resulting in a previous run `disconnect` running in parallel with
          // a current run `connect`
          return;
        }

        setIsSessionActive(false);
        console.error('Connection error:', error);
        toastAlert({
          title: 'There was an error connecting to the agent',
          description: `${error.name}: ${error.message}`,
        });
      });
  }, [room, appConfig, tokenSource]);

  const endSession = useCallback(() => {
    setIsSessionActive(false);
  }, []);

  return { room, isSessionActive, startSession, endSession };
}
